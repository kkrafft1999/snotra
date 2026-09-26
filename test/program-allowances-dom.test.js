// Program allowances in Settings › Tools, on the real markup (#408): the
// list, the dialog, and what they send to main. Main's side — resolving,
// checking, confirming natively — is faked here; it has tests of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const TOOL = '/Users/u/.ai-workplace/bin/ms-todo-cli';
const CACHE = '/Users/u/Library/Application Support/ms-todo';
const ENTRY = { path: TOOL, domains: ['graph.microsoft.com'], writePaths: [CACHE], trustd: true };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount({ platform = 'darwin', entries = [], setResults = [], chosen = { ok: true, path: CACHE } } = {}) {
  const dom = setupRendererDom();
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  const { initProgramAllowancesSetting } = await importRenderer('components', 'ProgramAllowancesSetting.js');

  let state = { platform, homeDir: '/Users/u', programAllowances: entries };
  const listeners = new Set();
  const sent = { set: [], remove: [], resolve: [] };
  const toolPermissions = {
    get: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    async setProgramAllowance(payload) {
      sent.set.push(payload);
      const result = setResults.shift() || { ok: true };
      if (result.ok) {
        const entry = { path: TOOL, domains: payload.domains, writePaths: payload.writePaths, trustd: payload.trustd };
        state = { ...state, programAllowances: [entry] };
        listeners.forEach((fn) => fn(state));
        return { ...result, entry };
      }
      return result;
    },
    async removeProgramAllowance(programPath) {
      sent.remove.push(programPath);
      state = { ...state, programAllowances: state.programAllowances.filter((e) => e.path !== programPath) };
      listeners.forEach((fn) => fn(state));
      return { ok: true };
    },
  };
  const api = {
    async resolveAllowanceProgram(text) {
      sent.resolve.push(text);
      return text === 'ms-todo-cli' ? { ok: true, path: TOOL, name: 'ms-todo-cli' } : { ok: false, error: { key: 'permissions.allowance.error.programNotFound', params: { program: text } } };
    },
    chooseAllowanceFolder: async () => chosen,
  };
  const setting = initProgramAllowancesSetting({ api, toolPermissions });
  setting.update({ shellOn: true, sandbox: { isolated: true, status: 'isolated' } });
  const $ = (id) => dom.document.getElementById(id);
  const overlayOpen = () => !$('program-allowance-overlay').classList.contains('hidden');
  return { dom, setting, sent, $, overlayOpen };
}

test('the card shows only with shell_execute on and a sandbox; empty says so', async (t) => {
  const { dom, setting, $ } = await mount();
  t.after(dom.cleanup);
  assert.equal($('settings-allowances-card').hidden, false);
  assert.equal($('settings-allowance-empty').hidden, false);
  setting.update({ shellOn: false, sandbox: { isolated: true } });
  assert.equal($('settings-allowances-card').hidden, true);
  setting.update({ shellOn: true, sandbox: { isolated: false, reason: 'platform' } });
  assert.equal($('settings-allowances-card').hidden, true, 'Windows has nothing to allow');
});

test('a row names the program, its ~ path and exactly its rights', async (t) => {
  const { dom, $ } = await mount({ entries: [ENTRY] });
  t.after(dom.cleanup);
  const row = $('settings-allowance-list').querySelector('.allowance-row');
  assert.equal(row.querySelector('.allowance-row__name').textContent, 'ms-todo-cli');
  assert.equal(row.querySelector('.allowance-row__path').textContent, '~/.ai-workplace/bin/ms-todo-cli');
  assert.deepEqual([...row.querySelectorAll('dt')].map((n) => n.textContent), ['Network', 'Also writes in', 'Certificates']);
  assert.equal(row.querySelector('.allowance-tag').textContent, 'weaker isolation');
  assert.equal(row.querySelector('[data-action="edit"]').getAttribute('aria-label'), 'Edit the allowance for ms-todo-cli');
  assert.equal($('settings-allowance-empty').hidden, true);
});

test('adding: the program is looked up, bad hosts are named, and main gets the whole entry', async (t) => {
  const { dom, $, sent, overlayOpen } = await mount({ setResults: [{ ok: false, code: 'cancelled' }, { ok: true }] });
  t.after(dom.cleanup);
  $('btn-add-program-allowance').click();
  await flush();
  assert.equal(overlayOpen(), true);
  assert.equal($('dialog-program-allowance-title').textContent, 'Add program');
  assert.equal(dom.document.activeElement, $('allowance-field-program'));
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
  assert.equal(sent.set.length, 0);

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
  assert.equal(overlayOpen(), true);
  assert.equal($('allowance-form-error').classList.contains('hidden'), true);
  assert.deepEqual(sent.set[0], {
    program: 'ms-todo-cli',
    domains: ['graph.microsoft.com', 'login.microsoftonline.com'],
    writePaths: [CACHE],
    trustd: true,
    previousPath: null,
  });

  $('btn-program-allowance-save').click();
  await flush();
  assert.equal(overlayOpen(), false);
  assert.equal($('settings-allowance-list').children.length, 1);
  assert.equal(dom.document.activeElement, $('settings-allowance-list').querySelector('[data-action="edit"]'),
    'the focus lands on the saved program');
});

test('editing starts from the entry; a refusal from main is shown in the dialog', async (t) => {
  const refusal = { ok: false, error: { key: 'permissions.allowance.error.folderTooBroad', params: { folder: '/Users/u' } } };
  const { dom, $, sent, overlayOpen } = await mount({ entries: [ENTRY], setResults: [refusal] });
  t.after(dom.cleanup);
  $('settings-allowance-list').querySelector('[data-action="edit"]').click();
  await flush();
  assert.equal($('dialog-program-allowance-title').textContent, 'Allowance for ms-todo-cli');
  assert.equal($('allowance-field-program').value, TOOL);
  assert.equal($('allowance-field-domains').value, 'graph.microsoft.com');
  assert.equal($('allowance-field-trustd').checked, true);
  assert.equal(dom.document.activeElement, $('allowance-field-domains'));

  // Removing the folder in the dialog, then saving.
  $('allowance-folder-list').querySelector('.allowance-folder__remove').click();
  assert.equal($('allowance-folders-none').hidden, false);
  $('btn-program-allowance-save').click();
  await flush();
  assert.equal(sent.set[0].previousPath, TOOL);
  assert.deepEqual(sent.set[0].writePaths, []);
  assert.equal(overlayOpen(), true);
  assert.equal($('allowance-form-error').textContent, '/Users/u is too broad: your home folder and everything above it stay closed.');

  // Escape closes the dialog only.
  $('dialog-program-allowance').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(overlayOpen(), false);
});

test('removing takes effect at once and moves the focus to what is left', async (t) => {
  const { dom, $, sent } = await mount({ entries: [ENTRY] });
  t.after(dom.cleanup);
  $('settings-allowance-list').querySelector('[data-action="remove"]').click();
  await flush();
  assert.deepEqual(sent.remove, [TOOL]);
  assert.equal($('settings-allowance-list').children.length, 0);
  assert.equal($('settings-allowance-empty').hidden, false);
  assert.equal(dom.document.activeElement, $('btn-add-program-allowance'));
});

test('off macOS the dialog does not offer the certificate check', async (t) => {
  const { dom, $ } = await mount({ platform: 'linux' });
  t.after(dom.cleanup);
  $('btn-add-program-allowance').click();
  await flush();
  assert.equal($('allowance-trustd-group').hidden, true);
});
