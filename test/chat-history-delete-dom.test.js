// Deleting a chat from the history column (#582), on the real DOM.
//
// The bin used to sit inside a `role="button"` row: Enter on it bubbled up and
// opened the chat, and one click deleted the chat and its attachments for good.
// Now the bin asks first, in the row, and the focus stays in the list.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const SESSIONS = [
  { id: 'chat-a', title: 'First', updatedAt: 30, workspaceRoot: null, messages: [] },
  { id: 'chat-b', title: 'Second', updatedAt: 20, workspaceRoot: null, messages: [] },
  { id: 'chat-c', title: 'Third', updatedAt: 10, workspaceRoot: null, messages: [] },
];

async function setup({ deleteResult = { ok: true }, history = SESSIONS } = {}) {
  const dom = setupRendererDom();
  const { initChatHistoryPanel } = await importRenderer('components', 'ChatHistoryPanel.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en');

  let sessions = history.map((s) => ({ ...s }));
  const deleted = [];
  appStore.currentChatId = 'chat-elsewhere';
  appStore.chatMessages = [];

  const panel = initChatHistoryPanel({
    api: {
      getChatHistory: async () => ({ sessions }),
      setActiveChatId: async () => ({ ok: true }),
      setUIPrefs: async () => ({ ok: true }),
      deleteChatSession: async (id) => {
        deleted.push(id);
        if (typeof deleteResult === 'function') return deleteResult();
        if (deleteResult?.ok) sessions = sessions.filter((s) => s.id !== id);
        return deleteResult;
      },
    },
    appStore,
    stopChatVoiceListening: () => {},
    persistCurrentChat: async () => {},
    renderChatMessages: () => {},
    updateChatChrome: () => {},
    onInputChanged: () => {},
    setChatTokenUsage: () => {},
    resetChatTokenUsage: () => {},
    seedGreetingIfWorkspace: () => {},
    onNewChatStarted: async () => {},
  });
  await panel.renderHistoryList();

  const document = dom.document;
  const row = (id) => document.querySelector(`.chat-history-row[data-chat-id="${id}"]`);
  return {
    dom,
    document,
    appStore,
    deleted,
    row,
    bin: (id) => row(id).querySelector('.chat-history-row-delete'),
    confirmBox: (id) => row(id)?.querySelector('.chat-history-row-confirm') || null,
    key: (target, key) => {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    },
  };
}

test('Enter on the bin no longer opens the chat, and the bin is a sibling of the open button', async () => {
  const { appStore, bin, row, key, deleted } = await setup();

  const event = key(bin('chat-b'), 'Enter');
  await flush();

  assert.equal(event.defaultPrevented, false, 'nothing may swallow the key the browser turns into a click');
  assert.equal(appStore.currentChatId, 'chat-elsewhere');
  assert.deepEqual(deleted, []);
  assert.equal(bin('chat-b').closest('.chat-history-row-main'), null);
  assert.equal(row('chat-b').getAttribute('role'), null);
});

test('the bin asks first and puts the focus on Cancel; nothing is deleted yet', async () => {
  const { document, bin, confirmBox, deleted } = await setup();

  bin('chat-b').click();
  await flush();

  const box = confirmBox('chat-b');
  assert.ok(box, 'the row shows the question');
  assert.equal(box.getAttribute('role'), 'group');
  assert.equal(document.getElementById(box.getAttribute('aria-labelledby')).textContent, 'Delete this chat?');
  assert.equal(document.activeElement, box.querySelector('.chat-history-row-confirm-cancel'));
  // Cancel is last, where the bin was: a double click lands on it.
  assert.equal(box.lastElementChild, box.querySelector('.chat-history-row-confirm-cancel'));
  assert.deepEqual(deleted, []);
});

test('Cancel and Escape keep the chat and give the focus back to the bin', async () => {
  const { document, bin, confirmBox, key, deleted } = await setup();

  bin('chat-b').click();
  confirmBox('chat-b').querySelector('.chat-history-row-confirm-cancel').click();
  assert.equal(confirmBox('chat-b'), null);
  assert.equal(document.activeElement, bin('chat-b'));

  bin('chat-b').click();
  key(confirmBox('chat-b').querySelector('.chat-history-row-confirm-cancel'), 'Escape');
  assert.equal(confirmBox('chat-b'), null);
  assert.equal(document.activeElement, bin('chat-b'));
  assert.deepEqual(deleted, []);
});

test('moving the focus out of the question cancels it', async () => {
  const { bin, confirmBox, row, deleted } = await setup();

  bin('chat-b').click();
  row('chat-a').querySelector('.chat-history-row-main').focus();
  await flush();

  assert.equal(confirmBox('chat-b'), null);
  assert.deepEqual(deleted, []);
});

test('only one row asks at a time', async () => {
  const { bin, confirmBox } = await setup();

  bin('chat-a').click();
  bin('chat-b').click();

  assert.equal(confirmBox('chat-a'), null);
  assert.ok(confirmBox('chat-b'));
});

test('Delete removes the chat and moves the focus to the row that took its place', async () => {
  const { document, bin, confirmBox, row, deleted } = await setup();

  bin('chat-b').click();
  confirmBox('chat-b').querySelector('.chat-history-row-confirm-delete').click();
  await flush();
  await flush();

  assert.deepEqual(deleted, ['chat-b']);
  assert.equal(row('chat-b'), null);
  assert.equal(document.activeElement, row('chat-c').querySelector('.chat-history-row-main'));
});

test('deleting the last row moves the focus to the one before, and the only row to the empty state', async () => {
  const { document, bin, confirmBox, row } = await setup();

  bin('chat-c').click();
  confirmBox('chat-c').querySelector('.chat-history-row-confirm-delete').click();
  await flush();
  await flush();
  assert.equal(document.activeElement, row('chat-b').querySelector('.chat-history-row-main'));

  const single = await setup({ history: [SESSIONS[0]] });
  single.bin('chat-a').click();
  single.confirmBox('chat-a').querySelector('.chat-history-row-confirm-delete').click();
  await flush();
  await flush();
  const empty = single.document.getElementById('chat-history-empty');
  assert.equal(empty.classList.contains('hidden'), false);
  assert.equal(single.document.activeElement, empty);
});

for (const [label, deleteResult] of [
  ['answers ok: false', { ok: false }],
  ['throws', () => { throw new Error('disk full'); }],
]) {
  test(`a delete that ${label} keeps the chat and says so in the row`, async () => {
    const { bin, confirmBox, row } = await setup({ deleteResult });

    bin('chat-b').click();
    confirmBox('chat-b').querySelector('.chat-history-row-confirm-delete').click();
    await flush();
    await flush();

    assert.ok(row('chat-b'), 'the row stays');
    const prompt = confirmBox('chat-b').querySelector('.chat-history-row-confirm-text');
    assert.equal(prompt.textContent, 'The chat could not be deleted.');
    assert.equal(prompt.getAttribute('role'), 'alert');
  });
}

test('the current chat is not reset when its delete fails', async () => {
  const { appStore, bin, confirmBox } = await setup({ deleteResult: { ok: false } });
  appStore.currentChatId = 'chat-b';
  appStore.chatMessages = [{ role: 'user', content: 'keep me' }];

  bin('chat-b').click();
  confirmBox('chat-b').querySelector('.chat-history-row-confirm-delete').click();
  await flush();
  await flush();

  assert.equal(appStore.currentChatId, 'chat-b');
  assert.equal(appStore.chatMessages.length, 1);
});

test('a failed history read shows a line instead of leaving the column shut', async () => {
  const dom = setupRendererDom();
  const { initChatHistoryPanel } = await importRenderer('components', 'ChatHistoryPanel.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en');
  dom.document.getElementById('app').classList.add('app--no-history');
  initChatHistoryPanel({
    api: {
      getChatHistory: async () => { throw new Error('unreadable'); },
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

  dom.document.getElementById('btn-toggle-chat-history').click();
  await flush();

  assert.equal(dom.document.getElementById('app').classList.contains('app--no-history'), false);
  const empty = dom.document.getElementById('chat-history-empty');
  assert.equal(empty.classList.contains('hidden'), false);
  assert.equal(empty.textContent, 'The history could not be read.');
});

test('a long title can be read in full on hover', async () => {
  const long = 'A'.repeat(200);
  const { row } = await setup({ history: [{ ...SESSIONS[0], title: long }] });
  assert.equal(row('chat-a').querySelector('.chat-history-row-main').title, long);
});
