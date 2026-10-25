// Settings › Tools › Security on the real markup (#1119): the list of
// workspaces, the details of the chosen one or of All workspaces, the program
// dialog with "Applies to", and what they send to main. Main is faked — an
// overview held in memory that every change updates; what main decides is in
// test/tool-security-handlers.test.js and test/tool-policy-scopes.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush, focusFixup } = require('./helpers/dom.js');
const { resolvePlatform } = require('../src/main/platforms');

const OPEN = '/Users/u/garden-planner';
const OTHER = '/Users/u/invoice-tool';
const GONE = '/Users/u/old-project';
const TOOL = '/Users/u/.ai-workplace/bin/ms-todo-cli';
const CACHE = '/Users/u/Library/Application Support/ms-todo';
const TODO = { path: TOOL, domains: ['graph.microsoft.com'], writePaths: [CACHE], trustd: true };
const TERRAFORM = { path: '/opt/homebrew/bin/terraform', domains: ['registry.terraform.io'], writePaths: [], trustd: true };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => JSON.parse(JSON.stringify(value));

function overviewWith(patch = {}) {
  return {
    integrity: 'ok',
    platformCapabilities: { secureStorage: true },
    platform: 'darwin',
    homeDir: '/Users/u',
    sandbox: { isolated: true, status: 'isolated', reason: '', platform: 'darwin' },
    activeRoot: OPEN,
    newWorkspaceSandbox: true,
    global: { programs: [TERRAFORM], hosts: ['gitlab.example.com:22'] },
    workspaces: [
      { root: OPEN, open: true, missing: false, sandboxOff: false, programs: [TODO], hosts: ['huggingface.co:443'] },
      { root: OTHER, open: false, missing: false, sandboxOff: false, programs: [], hosts: [] },
    ],
    sessionGrants: [],
    ...patch,
  };
}

async function mount({ overview = overviewWith(), answers = {}, chosen = { ok: true, path: CACHE }, open = true, phone = null, developer = null } = {}) {
  const dom = setupRendererDom();
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  const { initToolSecurityPanel } = await importRenderer('components', 'ToolSecurityPanel.js');
  const { initProgramAllowanceDialog } = await importRenderer('components', 'ProgramAllowanceDialog.js');
  // The page lives in a hidden section of the settings; here it is shown.
  dom.document.getElementById('panel-settings-sandbox').hidden = false;

  let current = clone(overview);
  const listeners = new Set();
  const sent = [];
  const notify = () => listeners.forEach((fn) => fn({}));
  const answer = (kind) => (answers[kind] || []).shift() || { ok: true };
  const wsOf = (root) => current.workspaces.find((ws) => ws.root === root);
  const listOf = (root) => (root ? wsOf(root).programs : current.global.programs);
  const toolPermissions = {
    get: () => ({ platform: current.platform, homeDir: current.homeDir }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    async setWorkspaceSandbox(enabled, root) {
      sent.push(['sandbox', enabled, root]);
      await flush();
      const result = answer('sandbox');
      if (result.ok) { wsOf(root).sandboxOff = !enabled; notify(); }
      return result;
    },
    async setProgramAllowance(payload) {
      sent.push(['program', payload]);
      const result = answer('program');
      if (!result.ok) return result;
      const entry = { path: TOOL, domains: payload.domains, writePaths: payload.writePaths, trustd: payload.trustd };
      if (payload.previousPath) {
        const from = payload.previousScope === 'workspace' ? payload.previousRoot : null;
        const list = listOf(from);
        list.splice(list.findIndex((other) => other.path === payload.previousPath), 1);
      }
      listOf(payload.root).push(entry);
      notify();
      return { ...result, entry, root: payload.root };
    },
    async removeProgramAllowance(programPath, scope) {
      sent.push(['remove-program', programPath, scope]);
      await flush();
      const list = listOf(scope.root);
      list.splice(list.findIndex((other) => other.path === programPath), 1);
      notify();
      return { ok: true };
    },
    async addHosts(payload) {
      sent.push(['hosts', payload]);
      const result = answer('hosts');
      if (!result.ok) return result;
      (payload.root ? wsOf(payload.root).hosts : current.global.hosts).push(...payload.hosts);
      notify();
      return result;
    },
    async removeWorkspaceHost(host, root) {
      sent.push(['close-host', host, root]);
      wsOf(root).hosts = wsOf(root).hosts.filter((entry) => entry !== host);
      notify();
      return { ok: true };
    },
    async removeGlobalHost(host) {
      sent.push(['close-global-host', host]);
      current.global.hosts = current.global.hosts.filter((entry) => entry !== host);
      notify();
      return { ok: true };
    },
    async setNewWorkspaceSandbox(enabled) {
      sent.push(['new-workspaces', enabled]);
      const result = answer('newWorkspaces');
      if (result.ok) { current.newWorkspaceSandbox = enabled; notify(); }
      return result;
    },
    async resetWorkspaceSandbox(root) {
      sent.push(['reset-ws', root]);
      const ws = wsOf(root);
      if (ws.missing) current.workspaces = current.workspaces.filter((entry) => entry !== ws);
      else Object.assign(ws, { sandboxOff: false, programs: [], hosts: [] });
      notify();
      return { ok: true };
    },
    async resetSandboxEverywhere() {
      sent.push(['reset-all']);
      return answer('resetAll');
    },
    async revokeSessionGrant(id) {
      sent.push(['revoke', id]);
      current.sessionGrants = current.sessionGrants.filter((grant) => grant.id !== id);
      notify();
      return { ok: true };
    },
  };
  const api = {
    getSandboxOverview: async () => clone(current),
    async resolveAllowanceProgram(text) {
      return text === 'ms-todo-cli' ? { ok: true, path: TOOL, name: 'ms-todo-cli' } : { ok: false, error: { key: 'permissions.allowance.error.programNotFound', params: { program: text } } };
    },
    chooseAllowanceFolder: async () => chosen,
  };
  // The workspaces open to the phone (#1195), held like the overview.
  let releases = phone ? clone(phone) : null;
  const releaseListeners = new Set();
  if (releases) {
    api.remote = {
      getReleases: async () => clone(releases),
      async setReleased(root, released) {
        sent.push(['phone', root, released]);
        await flush();
        const result = answer('phone');
        if (result.ok) {
          releases.released = released ? [...releases.released, root] : releases.released.filter((entry) => entry !== root);
          releaseListeners.forEach((fn) => fn());
        }
        return result;
      },
      onReleasesChanged: (fn) => { releaseListeners.add(fn); return () => releaseListeners.delete(fn); },
    };
  }
  // Developer mode (#1213), which shows the phone card with *Remote access* (#1216).
  let developerOn = developer === true;
  const developerListeners = new Set();
  if (developer !== null) {
    api.developerMode = {
      get: async () => ({ on: developerOn }),
      onChange: (fn) => { developerListeners.add(fn); return () => developerListeners.delete(fn); },
    };
  }
  const dialog = initProgramAllowanceDialog({ api, toolPermissions });
  const panel = initToolSecurityPanel({ api, toolPermissions, allowanceDialog: dialog });
  if (open) await panel.open();
  await flush();
  const doc = dom.document;
  const $ = (id) => doc.getElementById(id);
  const listItem = (key) => [...doc.querySelectorAll('.settings-sandbox-ws')].find((node) => node.dataset.key === key);
  const detail = () => $('settings-sandbox-detail');
  const focus = (key) => [...doc.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === key);
  const overlayOpen = () => !$('program-allowance-overlay').classList.contains('hidden');
  return {
    dom, doc, panel, sent, $, listItem, detail, focus, overlayOpen,
    setOverview: (next) => { current = clone(next); notify(); },
    setReleases: (next) => { releases = clone(next); releaseListeners.forEach((fn) => fn()); },
    setDeveloper: (on) => { developerOn = on; developerListeners.forEach((fn) => fn({ on })); },
  };
}

// ── The list ────────────────────────────────────────────────────────────────

test('the list starts with All workspaces, then every workspace with its state in words; the open one is chosen', async (t) => {
  const page = await mount({ overview: overviewWith({
    workspaces: [
      { root: OPEN, open: true, missing: false, sandboxOff: false, programs: [TODO], hosts: ['huggingface.co:443', '*.pytorch.org'] },
      { root: OTHER, open: false, missing: false, sandboxOff: true, programs: [], hosts: [] },
      { root: '/Users/u/notes', open: false, missing: false, sandboxOff: false, programs: [], hosts: [] },
      { root: GONE, open: false, missing: true, sandboxOff: false, programs: [], hosts: ['pypi.org:443'] },
    ],
  }) });
  t.after(page.dom.cleanup);
  const items = [...page.doc.querySelectorAll('.settings-sandbox-ws')];
  assert.deepEqual(items.map((node) => node.querySelector('.settings-sandbox-ws__label').textContent),
    ['All workspaces', 'garden-planner', 'invoice-tool', 'notes', 'old-project']);
  assert.deepEqual(items.map((node) => node.querySelector('.settings-sandbox-ws__meta').textContent), [
    '1 program · 1 host',
    '1 program · 2 hosts',
    'Sandbox off',
    'Sandbox on · nothing extra',
    'Folder missing',
  ]);
  assert.deepEqual(items.map((node) => node.dataset.tone), ['global', 'on', 'off', 'on', 'missing']);
  // The off one carries the struck-through shield, not only the colour.
  assert.equal(page.listItem(OTHER).querySelectorAll('.settings-sandbox-ws__icon path').length, 2);
  assert.equal(page.listItem(OPEN).querySelector('.settings-sandbox-ws__open').textContent, 'open');
  assert.equal(page.listItem(OPEN).getAttribute('aria-current'), 'true');
  assert.equal(page.listItem(OPEN).title, '~/garden-planner');
  assert.equal(page.$('settings-sandbox-detail-title').textContent, '~/garden-planner');
  assert.match(page.detail().textContent, /Every command and Python run in this folder/);
  // The group of workspaces is named, for a screen reader as well.
  assert.equal(page.doc.querySelectorAll('.settings-sandbox-list__group')[1].getAttribute('aria-labelledby'), 'settings-sandbox-list-workspaces');
});

test('without an open folder All workspaces is chosen and says what that means', async (t) => {
  const page = await mount({ overview: overviewWith({
    activeRoot: null,
    workspaces: [{ root: OTHER, open: false, missing: false, sandboxOff: true, programs: [], hosts: [] }],
  }) });
  t.after(page.dom.cleanup);
  assert.equal(page.listItem('*').getAttribute('aria-current'), 'true');
  const notice = page.detail().querySelector('.settings-sandbox-notice');
  assert.match(notice.textContent, /^No workspace open/);
  assert.equal(page.$('settings-sandbox-detail-title').textContent, 'All workspaces');
});

test('the list moves with the arrow keys and chooses with a click', async (t) => {
  const page = await mount();
  t.after(page.dom.cleanup);
  page.listItem(OPEN).focus();
  page.listItem(OPEN).dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(page.doc.activeElement, page.listItem(OTHER));
  page.doc.activeElement.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(page.doc.activeElement, page.listItem('*'));
  page.listItem(OTHER).click();
  await flush();
  assert.equal(page.listItem(OTHER).getAttribute('aria-current'), 'true');
  assert.equal(page.doc.activeElement, page.listItem(OTHER), 'the keyboard stays in the list');
  assert.match(page.detail().textContent, /Not open right now — changes apply the next time a run starts there\./);
});

// ── A workspace ─────────────────────────────────────────────────────────────

test('a workspace that is not open is switched without opening it; the switch keeps the focus', async (t) => {
  const page = await mount();
  t.after(page.dom.cleanup);
  page.listItem(OTHER).click();
  await flush();
  const input = () => page.focus(`sandbox:${OTHER}`);
  input().focus();
  input().checked = false;
  input().dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  // While main decides: marked, not disabled, so the focus stays (CR-B14-07).
  assert.equal(input().getAttribute('aria-disabled'), 'true');
  focusFixup(page.doc);
  assert.equal(page.doc.activeElement, input());
  await wait(5);
  await flush();
  assert.deepEqual(page.sent, [['sandbox', false, OTHER]]);
  assert.equal(page.doc.activeElement, input(), 'after the redraw too');
  assert.equal(input().checked, false);
  assert.equal(page.listItem(OTHER).querySelector('.settings-sandbox-ws__meta').textContent, 'Sandbox off');
  assert.equal(page.detail().querySelector(`[data-status-for="sandbox:${OTHER}"]`).textContent, 'Saved');
});

test('a cancelled system dialog puts the switch back without a word; a refusal says why', async (t) => {
  const refusal = { ok: false, error: { key: 'permissions.error.sandboxOffNeedsEncryption' } };
  const page = await mount({ answers: { sandbox: [{ ok: false, code: 'cancelled' }, refusal] } });
  t.after(page.dom.cleanup);
  const input = () => page.focus(`sandbox:${OPEN}`);
  input().checked = false;
  input().dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  await wait(5);
  await flush();
  assert.equal(input().checked, true);
  assert.equal(page.$('settings-sandbox-error').classList.contains('hidden'), true);
  input().checked = false;
  input().dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  await wait(5);
  await flush();
  assert.equal(input().checked, true);
  assert.equal(page.$('settings-sandbox-error').textContent, 'The sandbox cannot be switched off without encrypted storage.');
});

test('sandbox off: the tile says so, and the allowances rest', async (t) => {
  const overview = overviewWith();
  overview.workspaces[0].sandboxOff = true;
  const page = await mount({ overview });
  t.after(page.dom.cleanup);
  const tile = page.detail().querySelector('.settings-sandbox-tile');
  assert.equal(tile.dataset.tone, 'off');
  assert.equal(tile.querySelector('.settings-sandbox-tile__title').textContent, 'Sandbox off');
  assert.equal(tile.querySelector('.settings-sandbox-tile__note').textContent, 'The allowances below rest until it is on again.');
  const resting = [...page.detail().querySelectorAll('.settings-sandbox-block--resting')];
  assert.equal(resting.length, 2, 'programs and hosts');
  for (const block of resting) assert.match(block.textContent, /Resting while the sandbox is off\./);
});

test('programs: its own first, then those for every workspace, marked and leading there', async (t) => {
  const page = await mount();
  t.after(page.dom.cleanup);
  const rows = [...page.detail().querySelectorAll('.allowance-list .allowance-row')];
  assert.deepEqual(rows.map((row) => row.querySelector('.allowance-row__name').textContent), ['ms-todo-cli', 'terraform']);
  assert.equal(rows[0].querySelector('.allowance-row__path').textContent, '~/.ai-workplace/bin/ms-todo-cli');
  assert.deepEqual([...rows[0].querySelectorAll('dt')].map((n) => n.textContent), ['Network', 'Also writes in', 'Certificates']);
  assert.equal(rows[0].querySelector('.allowance-tag').textContent, 'weaker isolation');
  assert.ok(rows[0].querySelector('[data-action="edit-program"]'));
  // The global one is read-only here.
  assert.equal(rows[1].querySelector('[data-action="edit-program"]'), null);
  const chip = rows[1].querySelector('.settings-sandbox-chip');
  assert.equal(chip.textContent, 'All workspaces');
  assert.equal(chip.getAttribute('aria-label'), 'terraform applies in every workspace. Change it under All workspaces.');
  // So are the hosts kept open everywhere.
  const lines = [...page.detail().querySelectorAll('.settings-sandbox-line')].map((line) => line.querySelector('code').textContent);
  assert.deepEqual(lines, ['huggingface.co:443', 'gitlab.example.com:22']);
  chip.click();
  await flush();
  assert.equal(page.listItem('*').getAttribute('aria-current'), 'true');
  assert.equal(page.doc.activeElement, page.listItem('*'));
});

test('removing a program takes effect at once and moves the focus to what is left', async (t) => {
  const page = await mount();
  t.after(page.dom.cleanup);
  const remove = page.focus(`program-remove:${OPEN}:${TOOL}`);
  assert.equal(remove.getAttribute('aria-label'), 'Remove the allowance for ms-todo-cli');
  remove.click();
  remove.click();
  await wait(5);
  await flush();
  assert.deepEqual(page.sent, [['remove-program', TOOL, { scope: 'workspace', root: OPEN }]], 'a second press sends nothing');
  assert.equal(page.doc.activeElement, page.focus(`program-add:${OPEN}`));
});

test('hosts: added in a form under the list; a refusal is said at the field; Escape closes it', async (t) => {
  const refusal = { ok: false, error: { key: 'permissions.hosts.error.invalid' } };
  const page = await mount({ answers: { hosts: [refusal, { ok: true }] } });
  t.after(page.dom.cleanup);
  page.focus(`host-add:${OPEN}`).click();
  await flush();
  const input = () => page.focus(`host-input:${OPEN}`);
  assert.equal(page.doc.activeElement, input());
  input().value = '*.github.io';
  input().dispatchEvent(new page.dom.window.Event('input'));
  input().closest('form').dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(5);
  await flush();
  assert.equal(page.doc.activeElement, input());
  assert.equal(input().value, '*.github.io', 'what was typed stays');
  assert.equal(input().getAttribute('aria-invalid'), 'true');
  assert.equal(page.detail().querySelector('.settings-sandbox-hostform [role="alert"]').textContent, 'Snotra cannot keep this open. Write the host in one of the forms described here.');
  // The forms themselves are the hint next to the field, which the field names.
  assert.match(page.detail().querySelector('.settings-sandbox-hostform .modal-hint').textContent, /Shared domains such as github\.io only host by host\./);
  input().value = 'pypi.org:443';
  input().dispatchEvent(new page.dom.window.Event('input'));
  input().closest('form').dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(5);
  await flush();
  assert.deepEqual(page.sent.at(-1), ['hosts', { hosts: ['pypi.org:443'], scope: 'workspace', root: OPEN }]);
  assert.equal(page.detail().querySelector('.settings-sandbox-hostform'), null);
  assert.equal(page.doc.activeElement, page.focus(`host-add:${OPEN}`));
  assert.ok([...page.detail().querySelectorAll('.settings-sandbox-line code')].some((code) => code.textContent === 'pypi.org:443'));

  page.focus(`host-add:${OPEN}`).click();
  await flush();
  input().dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  assert.equal(page.detail().querySelector('.settings-sandbox-hostform'), null);
  assert.equal(page.doc.activeElement, page.focus(`host-add:${OPEN}`));
});

test('a host is closed by its trash button, named for the screen reader', async (t) => {
  const page = await mount();
  t.after(page.dom.cleanup);
  const close = page.focus(`host-close:${OPEN}:huggingface.co:443`);
  assert.equal(close.getAttribute('aria-label'), 'Close huggingface.co:443 for this workspace');
  close.click();
  await wait(5);
  await flush();
  assert.deepEqual(page.sent, [['close-host', 'huggingface.co:443', OPEN]]);
});

test('a folder that is gone is marked missing; its settings can be removed', async (t) => {
  const overview = overviewWith();
  overview.workspaces.push({ root: GONE, open: false, missing: true, sandboxOff: false, programs: [], hosts: ['pypi.org:443'] });
  const page = await mount({ overview });
  t.after(page.dom.cleanup);
  page.listItem(GONE).click();
  await flush();
  assert.match(page.detail().textContent, /This folder is gone/);
  assert.equal(page.detail().querySelector('.settings-sandbox-tile'), null, 'nothing to switch for a folder that is not there');
  const remove = page.focus(`remove-ws:${GONE}`);
  assert.equal(remove.getAttribute('aria-label'), 'Remove the sandbox settings of ~/old-project');
  remove.click();
  await wait(5);
  await flush();
  assert.deepEqual(page.sent, [['reset-ws', GONE]]);
  assert.equal(page.listItem(GONE), undefined);
  assert.equal(page.listItem('*').getAttribute('aria-current'), 'true');
  assert.equal(page.doc.activeElement, page.listItem('*'));
  assert.equal(page.$('settings-sandbox-announcer').textContent, 'Settings removed.');
});

test('the session allowances of the open workspace are listed there and revoked one by one', async (t) => {
  const page = await mount({ overview: overviewWith({
    sessionGrants: [
      { id: 'g1', tool: 'shell_execute', classes: ['execute'], scope: { key: 'approval.sandbox.scope.network', params: { target: 'pypi.org:443' } }, sandbox: 'network', grantedAt: 0, chatId: 'c1', chatTitle: 'Fix the build', current: true },
      { id: 'g2', tool: 'shell_execute', classes: ['execute'], scope: null, sandbox: 'write', grantedAt: 0, chatId: 'c1', chatTitle: 'Fix the build', current: true },
    ],
  }) });
  t.after(page.dom.cleanup);
  const cards = page.detail().querySelectorAll('.settings-sandbox-card');
  assert.equal(cards.length, 2);
  assert.match(cards[1].textContent, /^This session/);
  assert.match(cards[1].querySelector('.settings-grants__group-label').textContent, /Fix the build/);
  page.focus('grant:g1').click();
  await wait(5);
  await flush();
  assert.deepEqual(page.sent, [['revoke', 'g1']]);
  assert.equal(page.doc.activeElement, page.focus('grant:g2'));
  // Not listed with another workspace.
  page.listItem(OTHER).click();
  await flush();
  assert.doesNotMatch(page.detail().textContent, /This session/);
});

// ── All workspaces ──────────────────────────────────────────────────────────

test('All workspaces: the default for new ones, the programs and hosts everywhere, and what is built in', async (t) => {
  const page = await mount({ answers: { newWorkspaces: [{ ok: false, code: 'cancelled' }] } });
  t.after(page.dom.cleanup);
  page.listItem('*').click();
  await flush();
  const text = page.detail().textContent;
  assert.match(text, /Applies in every folder, also ones you open later\./);
  assert.match(text, /Sandbox on in new workspaces/);
  assert.match(text, /Hosts open everywhere/);
  assert.match(text, /What the sandbox always does/);
  assert.match(text, /On this computermacOS — the sandbox is built in\./);
  assert.match(text, /Reset the sandbox everywhere/);
  // The global programs can be edited here.
  assert.ok(page.focus(`program-edit:*:${TERRAFORM.path}`));
  // Switching off asks; cancelled, the switch goes back.
  const toggle = page.focus('new-workspaces');
  assert.equal(toggle.checked, true);
  toggle.checked = false;
  toggle.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  await wait(5);
  await flush();
  assert.deepEqual(page.sent, [['new-workspaces', false]]);
  assert.equal(page.focus('new-workspaces').checked, true);
  assert.equal(page.doc.activeElement, page.focus('new-workspaces'));
});

test('Windows: no switch, no programs or hosts — and the page says why', async (t) => {
  const overview = overviewWith({
    platform: 'win32',
    // What main sends: the register resolved for Windows (#1149).
    platformCapabilities: resolvePlatform({ platform: 'win32' }),
    sandbox: { isolated: false, status: 'unavailable', reason: 'platform', platform: 'win32' },
    global: { programs: [], hosts: [] },
  });
  overview.workspaces[0].programs = [];
  overview.workspaces[0].hosts = [];
  const page = await mount({ overview });
  t.after(page.dom.cleanup);
  assert.equal(page.listItem(OPEN).querySelector('.settings-sandbox-ws__meta').textContent, 'No sandbox');
  const tile = page.detail().querySelector('.settings-sandbox-tile');
  assert.equal(tile.querySelector('.settings-sandbox-tile__title').textContent, 'No sandbox on Windows');
  assert.equal(tile.querySelector('input'), null);
  assert.match(page.detail().textContent, /Nothing to set up on Windows yet/);
  assert.equal(page.detail().querySelector('.allowance-list, [data-action="add-program"]'), null);
  page.listItem('*').click();
  await flush();
  assert.match(page.detail().textContent, /Windows — no sandbox yet\./);
  assert.equal(page.focus('new-workspaces'), undefined);
});

// ── The program dialog ─────────────────────────────────────────────────────

test('adding: This workspace is preselected; the program is looked up, bad hosts are named, main gets the whole entry', async (t) => {
  const page = await mount({ answers: { program: [{ ok: false, code: 'cancelled' }, { ok: true }] } });
  t.after(page.dom.cleanup);
  const { $, dom } = page;
  page.focus(`program-add:${OPEN}`).click();
  await flush();
  assert.equal(page.overlayOpen(), true);
  assert.equal($('dialog-program-allowance-title').textContent, 'Add program');
  assert.equal(dom.document.activeElement, $('allowance-field-program'));
  assert.equal($('allowance-scope-workspace').checked, true);
  assert.equal($('allowance-scope-root').textContent, '~/garden-planner');
  assert.equal($('allowance-scope-workspace-desc').textContent, 'Only for runs in this folder. The usual choice.');
  assert.equal($('allowance-trustd-group').hidden, false, 'macOS offers the certificate check');

  $('allowance-field-program').value = 'ms-todo-cli';
  $('allowance-field-program').dispatchEvent(new dom.window.Event('input'));
  assert.equal($('allowance-program-status').textContent, 'Looking in your shell…');
  await wait(350);
  await flush();
  assert.equal($('allowance-program-status').textContent, 'Found in your shell: ~/.ai-workplace/bin/ms-todo-cli');

  $('allowance-field-domains').value = 'graph.microsoft.com bad_host';
  $('btn-program-allowance-save').click();
  await flush();
  assert.equal($('allowance-domains-invalid').textContent, 'Not a host name: bad_host');
  assert.equal(page.sent.length, 0);

  $('allowance-field-domains').value = 'graph.microsoft.com\nlogin.microsoftonline.com';
  $('allowance-field-domains').dispatchEvent(new dom.window.Event('input'));
  assert.equal($('allowance-domains-invalid').classList.contains('hidden'), true, 'a fix clears the complaint at once');
  $('btn-allowance-folder-add').click();
  await flush();
  assert.equal($('allowance-folder-list').querySelector('.allowance-folder__path').textContent, '~/Library/Application Support/ms-todo');
  $('allowance-field-trustd').checked = true;

  // The native dialog was cancelled: the form stays as it was.
  $('btn-program-allowance-save').click();
  await flush();
  assert.equal(page.overlayOpen(), true);
  assert.equal($('allowance-form-error').classList.contains('hidden'), true);
  assert.deepEqual(page.sent[0], ['program', {
    program: 'ms-todo-cli',
    domains: ['graph.microsoft.com', 'login.microsoftonline.com'],
    writePaths: [CACHE],
    trustd: true,
    credentials: [],
    scope: 'workspace',
    root: OPEN,
    previousPath: null,
    previousScope: undefined,
    previousRoot: null,
  }]);

  // Every workspace is the deliberate choice.
  $('allowance-scope-global').checked = true;
  $('btn-program-allowance-save').click();
  await wait(5);
  await flush();
  assert.equal(page.sent[1][1].scope, 'global');
  assert.equal(page.sent[1][1].root, null);
  assert.equal(page.overlayOpen(), false);
  assert.equal(page.doc.activeElement, page.focus(`program-add:${OPEN}`), 'saved elsewhere: the keyboard stays on Add');
});

test('from All workspaces the dialog preselects All workspaces; without a folder it offers nothing else', async (t) => {
  const page = await mount({ overview: overviewWith({ activeRoot: null, workspaces: [] }) });
  t.after(page.dom.cleanup);
  const { $ } = page;
  page.focus('program-add:*').click();
  await flush();
  assert.equal($('allowance-scope-global').checked, true);
  assert.equal($('allowance-scope-workspace').disabled, true);
  assert.equal($('allowance-scope-workspace-desc').textContent, 'Open a folder to choose it.');
  assert.equal($('allowance-scope-root').hidden, true);
});

test('editing starts from the entry in its scope; a refusal from main is shown in the dialog', async (t) => {
  const refusal = { ok: false, error: { key: 'permissions.allowance.error.folderTooBroad', params: { folder: '/Users/u' } } };
  const page = await mount({ answers: { program: [refusal] } });
  t.after(page.dom.cleanup);
  const { $, dom } = page;
  page.focus(`program-edit:${OPEN}:${TOOL}`).click();
  await flush();
  assert.equal($('dialog-program-allowance-title').textContent, 'Allowance for ms-todo-cli');
  assert.equal($('allowance-field-program').value, TOOL);
  assert.equal($('allowance-field-domains').value, 'graph.microsoft.com');
  assert.equal($('allowance-field-trustd').checked, true);
  assert.equal($('allowance-scope-workspace').checked, true);
  assert.equal(dom.document.activeElement, $('allowance-field-domains'));

  $('allowance-folder-list').querySelector('.allowance-folder__remove').click();
  assert.equal($('allowance-folders-none').hidden, false);
  $('btn-program-allowance-save').focus();
  $('btn-program-allowance-save').click();
  focusFixup(dom.document);
  await flush();
  assert.equal(page.sent[0][1].previousPath, TOOL);
  assert.equal(page.sent[0][1].previousScope, 'workspace');
  assert.equal(page.sent[0][1].previousRoot, OPEN);
  assert.deepEqual(page.sent[0][1].writePaths, []);
  assert.equal(page.overlayOpen(), true);
  assert.equal($('allowance-form-error').textContent, '/Users/u is too broad: your home folder and everything above it stay closed.');
  // CR-B13-03: the refused save leaves the focus on Save, inside the dialog.
  assert.equal(dom.document.activeElement, $('btn-program-allowance-save'));

  // Escape closes the dialog only.
  $('dialog-program-allowance').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(page.overlayOpen(), false);
});

test('credentials: proposed for the program, refused at the field, sent as typed — and never read back once saved (#1262)', async (t) => {
  const page = await mount();
  t.after(page.dom.cleanup);
  const { $, dom } = page;
  const doc = dom.document;
  const rows = () => [...$('allowance-credential-list').querySelectorAll('.allowance-credential')];
  const field = (row, name) => row.querySelector(`[data-field="${name}"]`);
  const typeInto = (input, value) => {
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input'));
  };

  page.focus(`program-add:${OPEN}`).click();
  await flush();
  assert.equal(rows().length, 0);
  assert.equal($('allowance-credentials-head').hidden, true);
  assert.equal($('allowance-credentials-warning').hidden, true, 'the guidance comes with the first token');
  typeInto($('allowance-field-program'), 'gh');
  $('allowance-field-domains').value = 'api.github.com';

  $('btn-allowance-credential-add').click();
  const [row] = rows();
  assert.equal(field(row, 'name').value, 'GH_TOKEN', 'the variable gh reads');
  assert.equal(field(row, 'value').type, 'password');
  assert.equal(doc.activeElement, field(row, 'value'), 'what is left to type is the token');
  assert.equal($('allowance-credentials-head').hidden, false);
  assert.equal($('allowance-credentials-warning').hidden, false);
  assert.equal(field(row, 'remove').getAttribute('aria-label'), 'Remove GH_TOKEN');

  // Refused: said under the rows, the field marked and focused; nothing goes to main.
  typeInto(field(row, 'name'), 'PATH');
  $('btn-program-allowance-save').click();
  await flush();
  assert.equal(page.sent.length, 0);
  assert.equal($('allowance-credentials-error').textContent, 'PATH is set by the shell or the sandbox and cannot carry a credential.');
  assert.equal(doc.activeElement, field(rows()[0], 'name'));
  assert.equal(field(rows()[0], 'name').getAttribute('aria-invalid'), 'true');
  assert.equal(field(rows()[0], 'name').getAttribute('aria-describedby'), 'allowance-credentials-error');
  typeInto(field(rows()[0], 'name'), 'GH_TOKEN');
  assert.equal($('allowance-credentials-error').classList.contains('hidden'), true, 'a fix clears the complaint');
  $('btn-program-allowance-save').click();
  await flush();
  assert.equal($('allowance-credentials-error').textContent, 'Enter the token for GH_TOKEN.');
  assert.equal(doc.activeElement, field(rows()[0], 'value'));

  typeInto(field(rows()[0], 'value'), ' ghp_new_token_value \n');
  $('btn-program-allowance-save').click();
  await wait(5);
  await flush();
  assert.deepEqual(page.sent[0][1].credentials, [{ name: 'GH_TOKEN', value: 'ghp_new_token_value' }]);
  assert.equal(page.overlayOpen(), false);
  assert.equal(doc.body.innerHTML.includes('ghp_new_token_value'), false, 'a typed token stays nowhere once the dialog is gone');
});

test('credentials: a saved one is masked; it can be renamed, replaced, kept or removed (#1262)', async (t) => {
  const saved = { ...TODO, credentials: [{ name: 'TODO_TOKEN', id: '11111111-aaaa-4aaa-8aaa-111111111111' }] };
  const page = await mount({ overview: overviewWith({
    workspaces: [{ root: OPEN, open: true, missing: false, sandboxOff: false, programs: [saved], hosts: [] }],
  }) });
  t.after(page.dom.cleanup);
  const { $, dom } = page;
  const doc = dom.document;
  const rows = () => [...$('allowance-credential-list').querySelectorAll('.allowance-credential')];
  const field = (row, name) => row.querySelector(`[data-field="${name}"]`);

  // The settings row names the variable.
  assert.match(page.detail().textContent, /CredentialsTODO_TOKENencrypted/);
  page.focus(`program-edit:${OPEN}:${TOOL}`).click();
  await flush();
  const [row] = rows();
  assert.equal(field(row, 'name').value, 'TODO_TOKEN');
  assert.equal(field(row, 'value'), null, 'no field holds the saved value');
  assert.equal(row.querySelector('.allowance-credential__masked').getAttribute('aria-hidden'), 'true');
  assert.equal(row.querySelector('.allowance-credential__note').textContent, 'Stored encrypted, not shown again');
  assert.equal(field(row, 'replace').getAttribute('aria-label'), 'Replace the token in TODO_TOKEN');

  field(row, 'replace').click();
  assert.equal(doc.activeElement, field(rows()[0], 'value'));
  assert.equal(field(rows()[0], 'keep').getAttribute('aria-label'), 'Keep the saved token in TODO_TOKEN');
  field(rows()[0], 'keep').click();
  assert.equal(doc.activeElement, field(rows()[0], 'replace'));

  // Removing one moves the focus to the next row, the last one to Add.
  $('btn-allowance-credential-add').click();
  assert.equal(field(rows()[1], 'name').value, 'MS_TODO_CLI_TOKEN', 'a program without a known variable gets <PROGRAM>_TOKEN');
  field(rows()[0], 'remove').click();
  assert.equal(rows().length, 1);
  assert.equal(doc.activeElement, field(rows()[0], 'remove'));
  field(rows()[0], 'remove').click();
  assert.equal(doc.activeElement, $('btn-allowance-credential-add'));
  assert.equal($('allowance-credentials-warning').hidden, true);
  $('btn-program-allowance-save').click();
  await wait(5);
  await flush();
  assert.deepEqual(page.sent[0][1].credentials, [], 'removed: main stores none and drops the secret');

  // Renamed, value kept: main gets the id, not a value.
  page.setOverview(overviewWith({ workspaces: [{ root: OPEN, open: true, missing: false, sandboxOff: false, programs: [saved], hosts: [] }] }));
  await flush();
  page.focus(`program-edit:${OPEN}:${TOOL}`).click();
  await flush();
  field(rows()[0], 'name').value = 'MS_TODO_TOKEN';
  field(rows()[0], 'name').dispatchEvent(new dom.window.Event('input'));
  assert.equal(field(rows()[0], 'remove').getAttribute('aria-label'), 'Remove MS_TODO_TOKEN', 'the buttons follow the new name');
  $('btn-program-allowance-save').click();
  await wait(5);
  await flush();
  assert.deepEqual(page.sent[1][1].credentials, [{ name: 'MS_TODO_TOKEN', id: '11111111-aaaa-4aaa-8aaa-111111111111' }]);
});

test('off macOS the dialog does not offer the certificate check', async (t) => {
  const overview = overviewWith({ platform: 'linux' });
  const page = await mount({ overview });
  t.after(page.dom.cleanup);
  page.focus(`program-add:${OPEN}`).click();
  await flush();
  assert.equal(page.$('allowance-trustd-group').hidden, true);
});

// ── The ways in ─────────────────────────────────────────────────────────────

test('reveal: the open workspace chosen and its switch focused; the programs on request; without a folder, All workspaces', async (t) => {
  const page = await mount({ open: false });
  t.after(page.dom.cleanup);
  assert.equal(await page.panel.reveal('sandbox'), true);
  assert.equal(page.listItem(OPEN).getAttribute('aria-current'), 'true');
  assert.equal(page.doc.activeElement, page.focus(`sandbox:${OPEN}`));
  page.listItem(OTHER).click();
  await flush();
  assert.equal(await page.panel.reveal('programs'), true);
  assert.equal(page.listItem(OPEN).getAttribute('aria-current'), 'true', 'back on the open one');
  assert.equal(page.doc.activeElement, page.focus(`program-add:${OPEN}`));

  page.setOverview(overviewWith({ activeRoot: null, workspaces: [] }));
  await flush();
  assert.equal(await page.panel.reveal('sandbox'), true);
  assert.equal(page.doc.activeElement, page.$('settings-sandbox-detail-title'));
});

// ── Access from your phone (#1195) ──────────────────────────────────────────

const NO_PHONE = { available: true, paired: false, released: [] };
const PAIRED = { available: true, paired: true, released: [] };

test('a window without the remote shows no phone switch', async (t) => {
  const page = await mount();
  t.after(page.dom.cleanup);
  assert.equal(page.focus(`phone:${OPEN}`), undefined);
});

test('without developer mode or a paired phone there is no phone card, as there is no Remote access', async (t) => {
  const page = await mount({ phone: NO_PHONE, developer: false });
  t.after(page.dom.cleanup);
  assert.equal(page.focus(`phone:${OPEN}`), undefined);
  assert.equal(page.detail().querySelector('.settings-sandbox-card--phone'), null);
  assert.equal(page.listItem(OPEN).querySelector('.settings-sandbox-ws__meta').textContent.includes('phone'), false);
});

test('developer mode shows the phone card and takes it away again, while the page is open', async (t) => {
  const page = await mount({ phone: NO_PHONE, developer: false });
  t.after(page.dom.cleanup);
  page.setDeveloper(true);
  await wait(5);
  await flush();
  assert.ok(page.focus(`phone:${OPEN}`), 'on: the card is there');
  page.setDeveloper(false);
  await wait(5);
  await flush();
  assert.equal(page.focus(`phone:${OPEN}`), undefined, 'off: gone again');
});

test('a folder already open to the phone keeps its card, so that it can be closed', async (t) => {
  const page = await mount({ phone: { available: true, paired: false, released: [OPEN] }, developer: false });
  t.after(page.dom.cleanup);
  assert.equal(page.focus(`phone:${OPEN}`).checked, true);
  assert.equal(page.focus(`phone:${OTHER}`), undefined, 'a closed one gets none');
});

test('every workspace starts closed to the phone; without a paired phone the card says so', async (t) => {
  const page = await mount({ phone: NO_PHONE, developer: true });
  t.after(page.dom.cleanup);
  const input = page.focus(`phone:${OPEN}`);
  assert.equal(input.checked, false);
  assert.equal(input.getAttribute('role'), 'switch');
  assert.equal(input.getAttribute('aria-disabled'), null, 'it can be opened before a phone is paired');
  const described = input.getAttribute('aria-describedby').split(' ').map((id) => page.$(id).textContent);
  assert.match(described[0], /can never loosen a protection/);
  assert.match(described[1], /No phone is paired yet/);
  assert.equal(page.doc.querySelector(`label[for="${input.id}"]`).textContent, 'Access from your phone');
});

test('opening a folder that is not open sends its root; the list says it, the focus stays', async (t) => {
  const page = await mount({ phone: PAIRED });
  t.after(page.dom.cleanup);
  page.listItem(OTHER).click();
  await flush();
  const input = () => page.focus(`phone:${OTHER}`);
  assert.equal(input().getAttribute('aria-describedby').split(' ').length, 1, 'with a paired phone, no note');
  input().focus();
  input().checked = true;
  input().dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  assert.equal(input().getAttribute('aria-disabled'), 'true', 'marked while main asks');
  await wait(5);
  await flush();
  assert.deepEqual(page.sent, [['phone', OTHER, true]]);
  focusFixup(page.doc);
  assert.equal(page.doc.activeElement, input());
  assert.equal(input().checked, true);
  assert.equal(page.listItem(OTHER).querySelector('.settings-sandbox-ws__meta').textContent, 'Sandbox on · nothing extra · phone');
  assert.equal(page.detail().querySelector(`[data-status-for="phone:${OTHER}"]`).textContent, 'Saved');
});

test('a cancelled dialog puts the phone switch back without a word; a refusal says why', async (t) => {
  const refusal = { ok: false, error: { key: 'remote.release.error.notSaved' } };
  const page = await mount({ phone: PAIRED, answers: { phone: [{ ok: false, code: 'cancelled' }, refusal] } });
  t.after(page.dom.cleanup);
  const input = () => page.focus(`phone:${OPEN}`);
  for (const attempt of [1, 2]) {
    input().checked = true;
    input().dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    await wait(5);
    await flush();
    assert.equal(input().checked, false);
    if (attempt === 1) assert.equal(page.$('settings-sandbox-error').classList.contains('hidden'), true);
  }
  assert.equal(page.$('settings-sandbox-error').textContent, 'The setting could not be saved.');
});

test('without encryption a folder cannot be opened, but one that is open can be closed', async (t) => {
  const page = await mount({ phone: { available: false, paired: true, released: [OTHER] } });
  t.after(page.dom.cleanup);
  const open = page.focus(`phone:${OPEN}`);
  assert.equal(open.getAttribute('aria-disabled'), 'true');
  assert.match(page.$(open.getAttribute('aria-describedby').split(' ')[1]).textContent, /does not encrypt/);
  open.checked = true;
  open.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(page.focus(`phone:${OPEN}`).checked, false);
  assert.deepEqual(page.sent, [], 'nothing asked of main');

  page.listItem(OTHER).click();
  await flush();
  const other = () => page.focus(`phone:${OTHER}`);
  assert.equal(other().getAttribute('aria-disabled'), null);
  other().checked = false;
  other().dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  await wait(5);
  await flush();
  assert.deepEqual(page.sent, [['phone', OTHER, false]]);
});

test('a change made elsewhere — or a phone paired — is drawn at once', async (t) => {
  const page = await mount({ phone: NO_PHONE });
  t.after(page.dom.cleanup);
  page.setReleases({ available: true, paired: true, released: [OPEN] });
  await wait(5);
  await flush();
  const input = page.focus(`phone:${OPEN}`);
  assert.equal(input.checked, true);
  assert.equal(input.getAttribute('aria-describedby').split(' ').length, 1);
});
