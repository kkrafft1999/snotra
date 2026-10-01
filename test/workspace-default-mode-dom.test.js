// The default mode per workspace in the renderer (#413): the checkbox under
// the mode pill's menu, the tag on the option that is the default, and the
// control in the header of Settings › Security (#448). Main is faked; what it
// decides is tested in tool-permission-handlers.test.js and
// chat-session-settings.test.js.

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

test('settings: the Security page shows the default, asks main to change it and follows main\'s answer', async () => {
  const dom = setupRendererDom();
  try {
    const { initWorkspaceModeSetting } = await importRenderer('components', 'WorkspaceModeSetting.js');
    let answer = { ok: true };
    const permissions = fakePermissions(baseState({ workspaceMode: 'ask-all' }), { answer: async () => answer });
    initWorkspaceModeSetting({ toolPermissions: permissions });
    const doc = dom.document;
    const radios = () => [...doc.querySelectorAll('#settings-security-mode-options input')];
    const checked = () => radios().find((input) => input.checked)?.value ?? null;

    assert.deepEqual(radios().map((input) => input.value), ['smart', 'ask-all', 'auto']);
    assert.deepEqual(
      [...doc.querySelectorAll('#settings-security-mode-options label')].map((label) => label.textContent),
      ['Smart', 'Always ask', 'Auto'],
    );
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
    assert.equal(doc.getElementById('settings-security-mode-state').hidden, true);

    // A failed save says so.
    answer = { ok: false, error: { key: 'permissions.error.autoNeedsEncryption' } };
    smart.checked = true;
    smart.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(checked(), 'auto');
    assert.equal(doc.getElementById('settings-security-mode-state').textContent, 'Auto cannot be switched on without encrypted storage.');
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
    const radios = () => [...doc.querySelectorAll('#settings-security-mode-options input')];
    assert.ok(radios().every((input) => input.disabled && !input.checked));
    assert.equal(doc.getElementById('settings-security-mode-state').textContent, 'Open a folder to choose its default.');

    permissions.push(baseState({ encryptionAvailable: false }));
    assert.deepEqual(radios().filter((input) => input.disabled).map((input) => input.value), ['auto']);
    assert.match(doc.getElementById('settings-security-mode-state').textContent, /not available as a default/);
  } finally {
    dom.cleanup();
  }
});

// CR-B14-08 (#621): the reason for a disabled "Auto" was only in a `title`.
test('settings: the state line describes the radiogroup, and each option carries its sentence', async () => {
  const dom = setupRendererDom();
  try {
    const { initWorkspaceModeSetting } = await importRenderer('components', 'WorkspaceModeSetting.js');
    const permissions = fakePermissions(baseState());
    initWorkspaceModeSetting({ toolPermissions: permissions });
    const doc = dom.document;
    const group = doc.getElementById('settings-security-mode-options');
    assert.deepEqual(group.getAttribute('aria-describedby').split(' '), ['settings-security-mode-state', 'settings-security-mode-note']);
    const radio = (value) => group.querySelector(`input[value="${value}"]`);
    const description = (value) => doc.getElementById(radio(value).getAttribute('aria-describedby'));
    assert.equal(description('smart').textContent, 'Reading runs without asking. File changes and sensitive files ask first. The default.');
    assert.equal(description('smart').hidden, true, 'read with the radio, not shown twice');
    assert.equal(description('smart').closest('label'), null, 'not part of the radio\'s name');
    assert.equal(radio('smart').closest('label').title, description('smart').textContent);
    assert.match(description('auto').textContent, /^No questions about tool calls/);

    permissions.push(baseState({ encryptionAvailable: false }));
    assert.equal(radio('auto').disabled, true);
    assert.equal(description('auto').textContent, 'Not available: this system offers no encrypted storage.');
    assert.equal(radio('auto').closest('label').title, 'Not available: this system offers no encrypted storage.');
  } finally {
    dom.cleanup();
  }
});

// CR-B14-09, item 3: a "Not saved" outlived the attempt it belonged to.
test('settings: a failed save is gone on the next open, in another folder and after a language change', async () => {
  const dom = setupRendererDom();
  const { setLocale } = await importRenderer('i18n.js');
  try {
    setLocale('en', { force: true });
    const { initWorkspaceModeSetting } = await importRenderer('components', 'WorkspaceModeSetting.js');
    const permissions = fakePermissions(baseState(), { answer: async () => ({ ok: false }) });
    const setting = initWorkspaceModeSetting({ toolPermissions: permissions });
    const doc = dom.document;
    const stateLine = doc.getElementById('settings-security-mode-state');
    const status = doc.getElementById('status-security-mode');
    const fail = async () => {
      const ask = doc.querySelector('#settings-security-mode-options input[value="ask-all"]');
      ask.checked = true;
      ask.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(stateLine.textContent, 'Not saved', 'no reason from main: the catalogue\'s own');
      assert.equal(status.textContent, 'Not saved');
    };
    const gone = (why) => {
      assert.equal(stateLine.hidden, true, why);
      assert.equal(status.textContent, '', why);
    };

    await fail();
    setting.reset();
    gone('opened again');

    await fail();
    permissions.push(baseState());
    assert.equal(stateLine.textContent, 'Not saved', 'the same folder keeps it');
    permissions.push(baseState({ workspaceRoot: '/Users/me/Projects/other' }));
    gone('another folder');

    await fail();
    setLocale('de');
    gone('language change');
    assert.deepEqual(
      [...doc.querySelectorAll('#settings-security-mode-options label')].map((label) => label.textContent),
      ['Intelligent', 'Immer fragen', 'Auto'],
    );
  } finally {
    setLocale('en', { force: true });
    dom.cleanup();
  }
});

// CR-B14-09, item 5.
test('settings: an unreadable permission state says so instead of "open a folder"', async () => {
  const dom = setupRendererDom();
  try {
    const { initWorkspaceModeSetting } = await importRenderer('components', 'WorkspaceModeSetting.js');
    const permissions = fakePermissions(null);
    initWorkspaceModeSetting({ toolPermissions: permissions });
    const doc = dom.document;
    const radios = [...doc.querySelectorAll('#settings-security-mode-options input')];
    assert.ok(radios.every((input) => input.disabled && !input.checked));
    const stateLine = doc.getElementById('settings-security-mode-state');
    assert.equal(stateLine.textContent, 'The permission state could not be read. Close the settings and open them again.');
    assert.equal(stateLine.classList.contains('error'), true);

    permissions.push(baseState());
    assert.equal(stateLine.hidden, true, 'readable again: nothing to say');
  } finally {
    dom.cleanup();
  }
});
