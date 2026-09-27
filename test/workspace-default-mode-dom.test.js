// The default mode per workspace in the renderer (#413): the checkbox under
// the mode pill's menu, the tag on the option that is the default, and the
// card in Settings › Permissions. Main is faked; what it decides is tested in
// tool-permission-handlers.test.js and chat-session-settings.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer } = require('./helpers/dom.js');

const ROOT = '/Users/me/Projects/snotra';

function baseState(patch = {}) {
  return {
    mode: 'smart',
    workspaceRoot: ROOT,
    workspaceMode: 'smart',
    encryptionAvailable: true,
    executionIsolation: { unisolated: false, tools: [], reason: '', pending: false },
    ...patch,
  };
}

/** Stand-in for initToolPermissionState: main's answers are scripted. */
function fakePermissions(initial, { answer = async () => ({ ok: true }) } = {}) {
  let state = initial;
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    get: () => state,
    mode: () => state?.mode || 'smart',
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    push(next) {
      state = next;
      for (const fn of listeners) fn(state);
    },
    async setMode() {
      return { ok: true };
    },
    async setWorkspaceMode(mode) {
      calls.push(mode);
      const result = await answer(mode);
      if (result?.ok) this.push({ ...state, workspaceMode: mode });
      return result;
    },
  };
}

async function withLocale(locale, fn) {
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale, { force: true });
  try {
    await fn();
  } finally {
    setLocale('en', { force: true });
  }
}

test('view: nothing to remember without a workspace, or with the chat and the folder at "Smart"', async () => {
  const { describeWorkspaceDefault } = await importRenderer('utils', 'tool-approval-view.js');
  assert.equal(describeWorkspaceDefault(null).visible, false);
  assert.equal(describeWorkspaceDefault(baseState({ workspaceRoot: null, mode: 'auto' })).visible, false);
  const quiet = describeWorkspaceDefault(baseState());
  assert.equal(quiet.visible, false);
  assert.equal(quiet.tagMode, null);
  assert.equal(quiet.folder, 'snotra');
});

test('view: the checkbox speaks about the chat\'s mode and says what ticking it does', async () => {
  const { describeWorkspaceDefault } = await importRenderer('utils', 'tool-approval-view.js');

  const auto = describeWorkspaceDefault(baseState({ mode: 'auto' }));
  assert.equal(auto.visible, true);
  assert.equal(auto.checked, false);
  assert.equal(auto.targetMode, 'auto');
  assert.deepEqual(auto.label, { before: '“Auto” for new chats in ', folder: 'snotra', after: ' too' });
  assert.equal(auto.hint, 'Also after a restart. You confirm it once in the system dialog.');

  const askAll = describeWorkspaceDefault(baseState({ mode: 'ask-all' }));
  assert.equal(askAll.hint, 'Also after a restart.');

  const remembered = describeWorkspaceDefault(baseState({ mode: 'auto', workspaceMode: 'auto' }));
  assert.equal(remembered.checked, true);
  assert.equal(remembered.isDefault, true);
  assert.equal(remembered.targetMode, 'smart', 'unticking takes the default back to "Smart"');
  assert.equal(remembered.tagMode, 'auto');
  assert.equal(remembered.tag, 'Default in snotra');
  assert.equal(remembered.hint, 'Untick it and new chats start with “Smart” again.');

  // The chat left the default: the box offers its own mode and names the default.
  const differs = describeWorkspaceDefault(baseState({ mode: 'smart', workspaceMode: 'auto' }));
  assert.equal(differs.visible, true);
  assert.equal(differs.checked, false);
  assert.equal(differs.isDefault, false);
  assert.equal(differs.targetMode, 'smart');
  assert.equal(differs.hint, 'At the moment new chats here start with “Auto”.');
});

test('view: "Auto" cannot be offered without encrypted storage; taking one back still can', async () => {
  const { describeWorkspaceDefault } = await importRenderer('utils', 'tool-approval-view.js');
  const blocked = describeWorkspaceDefault(baseState({ mode: 'auto', encryptionAvailable: false }));
  assert.equal(blocked.disabled, true);
  assert.equal(blocked.hint, 'Not available: this system offers no encrypted storage.');
  const takeBack = describeWorkspaceDefault(baseState({ mode: 'auto', workspaceMode: 'auto', encryptionAvailable: false }));
  assert.equal(takeBack.disabled, false);
});

test('view: the folder name comes from either kind of path', async () => {
  const { workspaceFolderName } = await importRenderer('utils', 'tool-approval-view.js');
  assert.equal(workspaceFolderName('/Users/me/snotra'), 'snotra');
  assert.equal(workspaceFolderName('/Users/me/snotra/'), 'snotra');
  assert.equal(workspaceFolderName('C:\\work\\Projekt'), 'Projekt');
  assert.equal(workspaceFolderName(''), '');
  assert.equal(workspaceFolderName(null), '');
});

test('menu: the tag sits on the default, the checkbox remembers the chat\'s mode', async () => {
  const dom = setupRendererDom();
  try {
    const { initToolModePicker } = await importRenderer('components', 'ToolModePicker.js');
    const permissions = fakePermissions(baseState({ mode: 'auto' }));
    initToolModePicker({ toolPermissions: permissions });
    const doc = dom.document;
    const footer = doc.getElementById('chat-tool-mode-footer');
    const box = doc.getElementById('chat-tool-mode-remember');

    doc.getElementById('btn-chat-tool-mode').click();
    assert.equal(footer.hidden, false);
    assert.equal(box.checked, false);
    assert.equal(doc.getElementById('chat-tool-mode-remember-label').textContent, '“Auto” for new chats in snotra too');
    assert.equal(doc.getElementById('chat-tool-mode-remember-label').querySelector('strong').textContent, 'snotra');
    assert.equal(doc.querySelector('.chat-tool-mode-default-tag'), null);

    box.checked = true;
    box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(permissions.calls, ['auto']);
    assert.equal(box.checked, true);
    assert.equal(doc.getElementById('chat-tool-mode-status').textContent, 'New chats in snotra start with “Auto” from now on.');
    assert.equal(doc.getElementById('chat-tool-mode-menu').classList.contains('hidden'), false, 'the menu stays open');

    const tag = doc.querySelector('.chat-tool-mode-option[data-mode="auto"] .chat-tool-mode-default-tag');
    assert.equal(tag?.textContent, 'Default in snotra');
    assert.equal(doc.querySelectorAll('.chat-tool-mode-default-tag').length, 1);
    assert.equal(doc.getElementById('btn-chat-tool-mode').title, 'Tool permissions: Auto, the default in snotra. Click to switch.');

    // Unticking takes it back.
    box.checked = false;
    box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(permissions.calls, ['auto', 'smart']);
    assert.equal(doc.getElementById('chat-tool-mode-status').textContent, 'New chats in snotra start with “Smart” again.');
    assert.equal(doc.querySelector('.chat-tool-mode-default-tag'), null);
  } finally {
    dom.cleanup();
  }
});

test('menu: a cancelled system dialog puts the checkbox back', async () => {
  const dom = setupRendererDom();
  try {
    const { initToolModePicker } = await importRenderer('components', 'ToolModePicker.js');
    const permissions = fakePermissions(baseState({ mode: 'auto' }), {
      answer: async () => ({ ok: false, code: 'cancelled', error: { key: 'permissions.error.workspaceAutoNotSet' } }),
    });
    initToolModePicker({ toolPermissions: permissions });
    const doc = dom.document;
    const box = doc.getElementById('chat-tool-mode-remember');
    doc.getElementById('btn-chat-tool-mode').click();
    box.checked = true;
    box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(box.checked, false);
    assert.equal(box.disabled, false);
    assert.equal(doc.getElementById('chat-tool-mode-status').textContent, 'Default unchanged.');
  } finally {
    dom.cleanup();
  }
});

test('menu: hidden with nothing to remember, and the same in German', async () => {
  const dom = setupRendererDom();
  try {
    const { initToolModePicker } = await importRenderer('components', 'ToolModePicker.js');
    const permissions = fakePermissions(baseState());
    initToolModePicker({ toolPermissions: permissions });
    const doc = dom.document;
    assert.equal(doc.getElementById('chat-tool-mode-footer').hidden, true);
    await withLocale('de', async () => {
      permissions.push(baseState({ mode: 'ask-all', workspaceMode: 'ask-all' }));
      assert.equal(doc.getElementById('chat-tool-mode-footer').hidden, false);
      assert.equal(doc.getElementById('chat-tool-mode-remember-label').textContent, '„Immer fragen“ auch für neue Chats in snotra');
      assert.equal(doc.getElementById('chat-tool-mode-remember-hint').textContent, 'Haken raus: Neue Chats starten wieder mit „Intelligent“.');
    });
  } finally {
    dom.cleanup();
  }
});

test('settings: the card shows the default, asks main to change it and follows main\'s answer', async () => {
  const dom = setupRendererDom();
  try {
    const { initWorkspaceModeSetting } = await importRenderer('components', 'WorkspaceModeSetting.js');
    let answer = { ok: true };
    const permissions = fakePermissions(baseState({ workspaceMode: 'ask-all' }), { answer: async () => answer });
    initWorkspaceModeSetting({ toolPermissions: permissions });
    const doc = dom.document;
    const radios = () => [...doc.querySelectorAll('#settings-workspace-mode-options input')];
    const checked = () => radios().find((input) => input.checked)?.value ?? null;

    assert.deepEqual(radios().map((input) => input.value), ['smart', 'ask-all', 'auto']);
    assert.deepEqual(
      [...doc.querySelectorAll('#settings-workspace-mode-options label')].map((label) => label.textContent),
      ['Smart', 'Always ask', 'Auto'],
    );
    assert.equal(doc.getElementById('settings-workspace-mode-name').textContent, ROOT);
    assert.equal(checked(), 'ask-all');

    const auto = radios().find((input) => input.value === 'auto');
    auto.checked = true;
    auto.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(permissions.calls, ['auto']);
    assert.equal(checked(), 'auto');

    // Cancelled in the system dialog: back to what main holds, without a word.
    answer = { ok: false, code: 'cancelled' };
    const smart = radios().find((input) => input.value === 'smart');
    smart.checked = true;
    smart.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(checked(), 'auto');
    assert.equal(doc.getElementById('settings-workspace-mode-state').hidden, true);

    // A failed save says so.
    answer = { ok: false, error: { key: 'permissions.error.autoNeedsEncryption' } };
    smart.checked = true;
    smart.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(checked(), 'auto');
    assert.equal(doc.getElementById('settings-workspace-mode-state').textContent, 'Auto cannot be switched on without encrypted storage.');
  } finally {
    dom.cleanup();
  }
});

test('settings: no folder, nothing to choose; no encrypted storage, no "Auto"', async () => {
  const dom = setupRendererDom();
  try {
    const { initWorkspaceModeSetting } = await importRenderer('components', 'WorkspaceModeSetting.js');
    const permissions = fakePermissions(baseState({ workspaceRoot: null, workspaceMode: null }));
    initWorkspaceModeSetting({ toolPermissions: permissions });
    const doc = dom.document;
    const radios = () => [...doc.querySelectorAll('#settings-workspace-mode-options input')];
    assert.ok(radios().every((input) => input.disabled && !input.checked));
    assert.equal(doc.getElementById('settings-workspace-mode-state').textContent, 'Open a folder to choose its default.');

    permissions.push(baseState({ encryptionAvailable: false }));
    assert.deepEqual(radios().filter((input) => input.disabled).map((input) => input.value), ['auto']);
    assert.match(doc.getElementById('settings-workspace-mode-state').textContent, /not available as a default/);
  } finally {
    dom.cleanup();
  }
});
