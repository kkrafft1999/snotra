// The sandbox switch of the open workspace on Settings › Security (#357,
// #543), in the real markup: what it does with main's answer, and that the
// keyboard stays on it while main decides and the page redraws around it
// (CR-B14-07). Main is faked; what it decides is tested in
// tool-permission-handlers.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer, focusFixup } = require('./helpers/dom.js');
const { describeSecurityOverview } = require('../src/application/permissions/security-overview');

const ROOT = '/work/snotra';
const SANDBOX = { status: 'isolated', isolated: true, reason: '', platform: 'darwin' };

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function permissionsState(patch = {}) {
  return {
    mode: 'smart',
    workspaceRoot: ROOT,
    workspaceMode: 'smart',
    workspaceSandboxDisabled: false,
    encryptionAvailable: true,
    homeDir: '/Users/u',
    ...patch,
  };
}

function overviewFor(state) {
  return describeSecurityOverview({
    root: state.workspaceRoot,
    mode: 'smart',
    tools: [{ name: 'shell_execute', shortDescription: 'Runs a command.', riskClasses: ['execute'], available: true, disabled: false, mcpServer: null }],
    execution: { sandbox: SANDBOX, programAllowances: [], workspaceSandboxDisabled: state.workspaceSandboxDisabled === true },
  });
}

/**
 * Stand-in for initToolPermissionState. `answer` is what main says to a
 * change; like `call()` there, a stored change refreshes the state and tells
 * every subscriber.
 */
function fakePermissions(initial, { answer = async () => ({ ok: true }) } = {}) {
  let state = initial;
  const listeners = new Set();
  const calls = [];
  const permissions = {
    calls,
    get: () => state,
    mode: () => 'smart',
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(next) {
      state = next;
      for (const listener of [...listeners]) listener(state);
    },
    async refresh() {
      return state;
    },
    async setWorkspaceSandbox(enabled) {
      calls.push(enabled);
      const result = await answer(enabled);
      if (result?.ok) permissions.push({ ...state, workspaceSandboxDisabled: !enabled });
      return result;
    },
    async setWorkspaceMode() {
      return { ok: true };
    },
  };
  return permissions;
}

async function mount({ state = permissionsState(), answer, withPage = false } = {}) {
  const dom = setupRendererDom();
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  const { initWorkspaceSandboxSetting } = await importRenderer('components', 'WorkspaceSandboxSetting.js');
  const toolPermissions = fakePermissions(state, { answer });
  const sandbox = initWorkspaceSandboxSetting({ toolPermissions });
  sandbox.update({ toolsOn: true, sandbox: SANDBOX });
  let page = null;
  if (withPage) {
    const { initSecurityPanel } = await importRenderer('components', 'SecurityPanel.js');
    page = initSecurityPanel({
      api: { getSecurityOverview: async () => overviewFor(toolPermissions.get()) },
      toolPermissions,
    });
    await page.open();
  }
  const doc = dom.document;
  return {
    dom,
    doc,
    sandbox,
    page,
    toolPermissions,
    input: () => doc.getElementById('input-workspace-sandbox'),
    stateLine: () => doc.getElementById('settings-sandbox-state'),
    status: () => doc.getElementById('status-workspace-sandbox'),
    flip(on) {
      const input = doc.getElementById('input-workspace-sandbox');
      input.checked = on;
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    setLocale,
    cleanup: () => {
      // A page left open would ask main again after the window is gone.
      page?.close();
      dom.cleanup();
    },
  };
}

// ── Focus (CR-B14-07) ────────────────────────────────────────────────────

test('the sandbox switch keeps the focus while main decides and after the page redraws', async (t) => {
  let release;
  const ui = await mount({ withPage: true, answer: () => new Promise((resolve) => { release = resolve; }) });
  t.after(ui.cleanup);
  const { doc, dom } = ui;
  assert.equal(await ui.page.reveal('sandbox'), true);
  assert.equal(doc.activeElement === ui.input(), true);

  ui.flip(false);
  // Busy: marked, not disabled, so Chromium does not drop the focus.
  assert.equal(ui.input().disabled, false);
  assert.equal(ui.input().getAttribute('aria-disabled'), 'true');
  focusFixup(doc);
  assert.equal(doc.activeElement === ui.input(), true);

  // A second press while main decides does nothing.
  const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  ui.input().dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(ui.toolPermissions.calls, [false]);

  // Main stores it; the state refreshes and the page redraws its rows, with
  // the switch moved into the new execute row.
  release({ ok: true });
  await settle();
  await settle();
  focusFixup(doc);
  assert.equal(ui.input().hasAttribute('aria-disabled'), false);
  assert.equal(ui.input().checked, false);
  assert.equal(doc.querySelector('.settings-security-row[data-risk-class="execute"]').contains(ui.input()), true);
  assert.equal(doc.activeElement === ui.input(), true, 'the keyboard is still on the switch');
});
