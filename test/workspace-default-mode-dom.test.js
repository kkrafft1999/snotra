// The default mode per workspace in the renderer (#413): the tag on the option
// that is the default — every pick in the menu writes it since #1337, so there
// is no checkbox any more — and the control in the header of Settings ›
// Security (#448). Main is faked; what it
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
    platformCapabilities: { secureStorage: true },
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
    async setMode(mode) {
      // Main writes the pick as the folder's default as well (#1337).
      this.push({ ...state, mode, workspaceMode: state?.workspaceRoot ? mode : state?.workspaceMode });
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

test('view: no tag without a workspace', async () => {
  const { describeWorkspaceDefault } = await importRenderer('utils', 'tool-approval-view.js');
  assert.equal(describeWorkspaceDefault(null).tagMode, null);
  const none = describeWorkspaceDefault(baseState({ workspaceRoot: null, mode: 'auto' }));
  assert.equal(none.tagMode, null);
  assert.equal(none.tag, '');
  assert.equal(none.isDefault, false);
});

test('view: the tag names the folder\'s default, "Smart" included', async () => {
  const { describeWorkspaceDefault } = await importRenderer('utils', 'tool-approval-view.js');
  const fresh = describeWorkspaceDefault(baseState());
  assert.equal(fresh.folder, 'snotra');
  assert.equal(fresh.tagMode, 'smart');
  assert.equal(fresh.tag, 'Default in snotra');
  assert.equal(fresh.isDefault, true);

  const auto = describeWorkspaceDefault(baseState({ mode: 'auto', workspaceMode: 'auto' }));
  assert.equal(auto.tagMode, 'auto');
  assert.equal(auto.isDefault, true);

  // A chat from the history with a mode of its own: the tag stays where new chats start.
  const differs = describeWorkspaceDefault(baseState({ mode: 'smart', workspaceMode: 'ask-all' }));
  assert.equal(differs.tagMode, 'ask-all');
  assert.equal(differs.isDefault, false);
});

test('view: the folder name comes from either kind of path', async () => {
  const { workspaceFolderName } = await importRenderer('utils', 'tool-approval-view.js');
  assert.equal(workspaceFolderName('/Users/me/snotra'), 'snotra');
  assert.equal(workspaceFolderName('/Users/me/snotra/'), 'snotra');
  assert.equal(workspaceFolderName('C:\\work\\Projekt'), 'Projekt');
  assert.equal(workspaceFolderName(''), '');
  assert.equal(workspaceFolderName(null), '');
});

test('menu: a pick moves the tag and says it holds for new chats in the folder', async () => {
  const dom = setupRendererDom();
  try {
    const { initToolModePicker } = await importRenderer('components', 'ToolModePicker.js');
    const permissions = fakePermissions(baseState());
    initToolModePicker({ toolPermissions: permissions });
    const doc = dom.document;
    const tagOn = () => [...doc.querySelectorAll('.chat-tool-mode-default-tag')]
      .map((tag) => tag.closest('.chat-tool-mode-option').dataset.mode);

    assert.equal(doc.getElementById('chat-tool-mode-footer'), null, 'no checkbox any more');
    doc.getElementById('btn-chat-tool-mode').click();
    assert.deepEqual(tagOn(), ['smart']);

    doc.querySelector('.chat-tool-mode-option[data-mode="ask-all"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(doc.getElementById('chat-tool-mode-status').textContent, 'Permission mode: Always ask, also for new chats in snotra');
    assert.equal(doc.getElementById('btn-chat-tool-mode').title, 'Tool permissions: Always ask, the default in snotra. Click to switch.');
    doc.getElementById('btn-chat-tool-mode').click();
    assert.deepEqual(tagOn(), ['ask-all']);
    assert.equal(doc.querySelector('.chat-tool-mode-default-tag').textContent, 'Default in snotra');
  } finally {
    dom.cleanup();
  }
});

test('menu: without a folder the status names no folder, and German reads the same', async () => {
  const dom = setupRendererDom();
  try {
    const { initToolModePicker } = await importRenderer('components', 'ToolModePicker.js');
    const permissions = fakePermissions(baseState({ workspaceRoot: null, workspaceMode: null }));
    initToolModePicker({ toolPermissions: permissions });
    const doc = dom.document;
    doc.getElementById('btn-chat-tool-mode').click();
    assert.equal(doc.querySelector('.chat-tool-mode-default-tag'), null);
    doc.querySelector('.chat-tool-mode-option[data-mode="ask-all"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(doc.getElementById('chat-tool-mode-status').textContent, 'Permission mode: Always ask');

    await withLocale('de', async () => {
      permissions.push(baseState({ mode: 'ask-all' }));
      doc.querySelector('.chat-tool-mode-option[data-mode="smart"]').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(doc.getElementById('chat-tool-mode-status').textContent, 'Berechtigungsmodus: Intelligent, auch für neue Chats in snotra');
      doc.getElementById('btn-chat-tool-mode').click();
      assert.equal(doc.querySelector('.chat-tool-mode-default-tag').textContent, 'Standard in snotra');
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

    permissions.push(baseState({ platformCapabilities: { secureStorage: false } }));
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
    assert.equal(description('smart').textContent, 'Reading runs without asking. File changes and sensitive files ask first. Every new folder starts here.');
    assert.equal(description('smart').hidden, true, 'read with the radio, not shown twice');
    assert.equal(description('smart').closest('label'), null, 'not part of the radio\'s name');
    assert.equal(radio('smart').closest('label').title, description('smart').textContent);
    assert.match(description('auto').textContent, /^No questions about tool calls/);

    permissions.push(baseState({ platformCapabilities: { secureStorage: false } }));
    assert.equal(radio('auto').disabled, true);
    assert.equal(description('auto').textContent, 'Not available: this system offers no encrypted storage.');
    assert.equal(radio('auto').closest('label').title, 'Not available: this system offers no encrypted storage.');
  } finally {
    dom.cleanup();
  }
});

// CR-B14-09, item 3: a "Not saved" outlived the attempt it belonged to.
// The Windows CI of #623: a read of main's state that fails while main writes
// came back as null, counted as "another folder" and took the fresh "Saved"
// with it — the e2e test waited for it in vain.
test('settings: a fresh "Saved" survives an unreadable state in between', async () => {
  const dom = setupRendererDom();
  const { setLocale } = await importRenderer('i18n.js');
  try {
    setLocale('en', { force: true });
    const { initWorkspaceModeSetting } = await importRenderer('components', 'WorkspaceModeSetting.js');
    const permissions = fakePermissions(baseState());
    initWorkspaceModeSetting({ toolPermissions: permissions });
    const doc = dom.document;
    const status = doc.getElementById('status-security-mode');
    const ask = doc.querySelector('#settings-security-mode-options input[value="ask-all"]');
    ask.checked = true;
    ask.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(status.textContent, 'Saved');
    const after = permissions.get();
    permissions.push(null);
    permissions.push(after);
    assert.equal(status.textContent, 'Saved');
    assert.equal(status.classList.contains('is-visible'), true);
  } finally {
    dom.cleanup();
  }
});

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
    gone('the page was closed');

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
