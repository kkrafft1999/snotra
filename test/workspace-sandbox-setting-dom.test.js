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

// ── The change handler (CR-B14-09, item 14) ─────────────────────────────

test('a cancelled system dialog puts the switch back without a word', async (t) => {
  const ui = await mount({ answer: async () => ({ ok: false, code: 'cancelled', error: { key: 'permissions.error.sandboxNotSwitchedOff' } }) });
  t.after(ui.cleanup);
  ui.flip(false);
  await settle();
  assert.deepEqual(ui.toolPermissions.calls, [false]);
  assert.equal(ui.input().checked, true, 'main holds "on"');
  assert.equal(ui.stateLine().hidden, true);
  assert.equal(ui.status().textContent, '');
  assert.equal(ui.input().hasAttribute('aria-disabled'), false, 'ready for the next try');
});

test('a failed save shows main\'s reason under the tile and "Not saved" next to the switch', async (t) => {
  const ui = await mount({ answer: async () => ({ ok: false, error: { key: 'permissions.error.policyUnreadable' } }) });
  t.after(ui.cleanup);
  ui.flip(false);
  await settle();
  assert.equal(ui.input().checked, true);
  assert.equal(ui.stateLine().hidden, false);
  assert.equal(ui.stateLine().textContent, 'The permissions file could not be read, so nothing was changed. Try again in a moment.');
  assert.equal(ui.status().textContent, 'Not saved');
  assert.equal(ui.status().classList.contains('is-error'), true);
  assert.deepEqual(ui.input().getAttribute('aria-describedby').split(' '),
    ['settings-sandbox-tile-body', 'settings-sandbox-tile-note', 'settings-sandbox-state']);
});

// CR-B14-09, item 3: the text belonged to an attempt that is over.
test('a failure is gone after a language change, in another folder and on the next open', async (t) => {
  const ui = await mount({ answer: async () => ({ ok: false }) });
  t.after(ui.cleanup);
  const fail = async () => {
    ui.flip(false);
    await settle();
    assert.equal(ui.stateLine().textContent, 'Not saved', 'no reason from main: the catalogue\'s own');
    assert.equal(ui.status().textContent, 'Not saved');
  };
  const gone = (why) => {
    assert.equal(ui.stateLine().hidden, true, why);
    assert.equal(ui.stateLine().textContent, '', why);
    assert.equal(ui.status().textContent, '', why);
  };

  await fail();
  ui.setLocale('de');
  gone('language change');
  assert.equal(ui.doc.getElementById('settings-sandbox-tile-title').textContent, 'Sandbox aktiv');
  ui.setLocale('en');

  await fail();
  ui.toolPermissions.push(permissionsState({ workspaceRoot: '/work/other' }));
  gone('another folder');

  await fail();
  ui.toolPermissions.push(permissionsState({ workspaceRoot: '/work/other' }));
  assert.equal(ui.stateLine().textContent, 'Not saved', 'the same folder keeps it');
  ui.sandbox.update({ toolsOn: true, sandbox: SANDBOX });
  gone('the settings were opened');
});

// CR-B14-09, item 1: "off" cannot be stored without safeStorage.
test('without encrypted storage the switch does not offer "off", says why, and still switches back on', async (t) => {
  const ui = await mount({ state: permissionsState({ encryptionAvailable: false }) });
  t.after(ui.cleanup);
  const { doc: d, dom } = ui;
  const note = d.getElementById('settings-sandbox-tile-note');
  assert.equal(ui.input().checked, true);
  assert.equal(ui.input().getAttribute('aria-disabled'), 'true');
  assert.equal(ui.input().disabled, false, 'still focusable, with its reason');
  assert.equal(note.textContent, 'It cannot be switched off here: this system offers no encrypted storage.');
  const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  ui.input().dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  // Past the guard, from code: the flip does not count and main is not asked.
  ui.flip(false);
  await settle();
  assert.equal(ui.input().checked, true);
  assert.deepEqual(ui.toolPermissions.calls, []);

  // Switched off before (a system that had a keyring then): back on works.
  ui.toolPermissions.push(permissionsState({ encryptionAvailable: false, workspaceSandboxDisabled: true }));
  assert.equal(ui.input().checked, false);
  assert.equal(ui.input().hasAttribute('aria-disabled'), false);
  assert.equal(note.textContent, '');
  ui.input().focus();
  ui.flip(true);
  await settle();
  focusFixup(d);
  assert.deepEqual(ui.toolPermissions.calls, [true]);
  assert.equal(ui.input().checked, true);
  assert.equal(ui.input().getAttribute('aria-disabled'), 'true', 'and from now on "off" is not offered');
  assert.equal(d.activeElement === ui.input(), true, 'the keyboard stays on the switch');
});

// CR-B14-09, item 5.
test('an unreadable permission state is not "no folder" and not "Sandbox active"', async (t) => {
  const ui = await mount({ state: null });
  t.after(ui.cleanup);
  const d = ui.doc;
  assert.equal(d.getElementById('settings-sandbox-tile-title').textContent, 'Sandbox state unknown');
  assert.equal(d.getElementById('settings-sandbox-tile-body').textContent, 'The permission state could not be read. Close the settings and open them again.');
  assert.equal(d.getElementById('settings-sandbox-tile').dataset.tone, 'neutral');
  assert.equal(d.getElementById('settings-sandbox-workspace-name').textContent, '');
  assert.equal(ui.input().disabled, true);
});
