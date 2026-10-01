// The smaller findings of block B12 (#586) that can be reached from the DOM:
// a zero share in English, a permission change reported during a read, the
// mode menu after Tab, and a column folded away with the focus inside.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('a zero share comes from the same formatter as every other share', async () => {
  setupRendererDom();
  const { formatShare } = await importRenderer('components', 'TokenBreakdownPanel.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  assert.equal(formatShare(0), '0%');
  assert.equal(formatShare(0.05), '5%');
  setLocale('de', { force: true });
  assert.equal(formatShare(0), '0 %');
  assert.equal(formatShare(0.05), '5 %');
  setLocale('en', { force: true });
});

test('a permission change reported during a read is read once more, and the newer state wins', async () => {
  setupRendererDom();
  const { initToolPermissionState } = await importRenderer('state', 'tool-permissions.js');
  let mainMode = 'smart';
  const reads = [];
  let notifyChange = null;
  const api = {
    getToolPermissionState: () => {
      // Main answers with the state of the moment the read was made.
      const answer = deferred();
      reads.push({ answer, mode: mainMode });
      return answer.promise;
    },
    onToolPermissionsChanged: (fn) => { notifyChange = fn; },
  };
  const permissions = initToolPermissionState({ api });
  const seen = [];
  permissions.subscribe((state) => seen.push(state?.mode));

  const first = permissions.refresh();
  // Main changes the mode and reports it while the first read is running.
  mainMode = 'auto';
  notifyChange();
  reads[0].answer.resolve({ mode: reads[0].mode });
  await flush();
  assert.equal(reads.length, 2, 'one more read follows');
  reads[1].answer.resolve({ mode: mainMode });

  const final = await first;
  assert.equal(final.mode, 'auto');
  assert.equal(permissions.mode(), 'auto');
  assert.deepEqual(seen, ['auto'], 'listeners hear the final state only');
});

function fakePermissions(state) {
  return {
    get: () => state,
    mode: () => state.mode,
    subscribe: () => () => {},
    refresh: async () => state,
    setMode: async () => ({ ok: true }),
    setWorkspaceMode: async () => ({ ok: true }),
  };
}

test('tabbing past the mode menu closes it', async () => {
  const dom = setupRendererDom();
  const { initToolModePicker } = await importRenderer('components', 'ToolModePicker.js');
  const picker = initToolModePicker({
    toolPermissions: fakePermissions({
      mode: 'smart',
      workspaceRoot: '/work',
      workspaceMode: 'smart',
      encryptionAvailable: true,
      executionIsolation: { unisolated: false, tools: [], reason: '', pending: false },
    }),
  });
  const doc = dom.document;
  doc.getElementById('btn-chat-tool-mode').click();
  assert.equal(picker.isOpen(), true);
  assert.ok(doc.getElementById('chat-tool-mode-list').contains(doc.activeElement));

  // Moving inside the menu keeps it open.
  doc.getElementById('chat-tool-mode-security-link').focus();
  assert.equal(picker.isOpen(), true);

  doc.getElementById('btn-chat-send').focus();
  assert.equal(picker.isOpen(), false);
  assert.equal(doc.getElementById('btn-chat-tool-mode').getAttribute('aria-expanded'), 'false');
});

test('folding the history away with the focus inside puts it on the toggle', async () => {
  const dom = setupRendererDom();
  const { initChatHistoryPanel } = await importRenderer('components', 'ChatHistoryPanel.js');
  const { appStore } = await importRenderer('state', 'store.js');
  appStore.currentChatId = 'other';
  const panel = initChatHistoryPanel({
    api: {
      getChatHistory: async () => ({ sessions: [{ id: 'a', title: 'A', updatedAt: 1, messages: [] }] }),
      setUIPrefs: async () => ({ ok: true }),
    },
    appStore,
    stopChatVoiceListening: () => {},
    persistCurrentChat: async () => {},
    renderChatMessages: () => {},
    updateChatChrome: () => {},
    onInputChanged: () => {},
    onNewChatStarted: async () => {},
  });
  panel.setHistoryOpen(true, { persist: false });
  await panel.renderHistoryList();
  dom.document.querySelector('.chat-history-row-main').focus();

  // The resizer folds it for lack of room.
  panel.setHistoryOpen(false, { persist: false });
  await flush();
  assert.equal(dom.document.activeElement, dom.document.getElementById('btn-toggle-chat-history'));
});
