// Who sets a chat's time (#245), and who writes it at all (#981).
//
// The date in the history is meant to say when the chat was held. The
// renderer used to stamp every write — and it wrote the chat it left even
// when it had only been looked at, so an old chat moved to "today" and to the
// top without a word said. Since #245 main sets the time; since #981 the
// renderer writes no chat at all: main saves a turn when it runs. Checked
// here: looking at chats, starting a new one, being named — none of it
// writes. What main stamps is checked in test/chat-history-service.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const GEFUEHRT = {
  id: 'chat-alt',
  title: 'Alter Chat',
  updatedAt: 10,
  workspaceRoot: null,
  messages: [
    { role: 'user', content: 'Hallo' },
    { role: 'assistant', content: 'Guten Tag' },
  ],
};

async function mountChat({ sessions = [], activeChatId = null } = {}) {
  const dom = setupRendererDom();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');

  appStore.chatMessages = [];
  appStore.currentChatId = null;
  appStore.currentChatTitle = '';

  const upserts = [];
  const api = {
    // The renderer has no writing channel any more; a call would land here.
    onChatDelta: () => {},
    onChatProgress: () => {},
    onChatToolLine: () => {},
    getChatHistory: async () => ({ sessions, activeChatId }),
    setActiveChatId: async () => {},
    upsertChatSession: async (row) => {
      upserts.push(row);
      return { ok: true };
    },
    nameChat: async () => ({ title: null }),
    writeClipboardText: async () => ({ ok: true }),
    abortChat: async () => ({ ok: true }),
    chat: async () => ({ ok: true }),
  };

  const chat = initChatStream({
    api,
    appStore,
    onInputChanged() {},
    stopChatVoiceListening() {},
    activeProviderConfigured: () => true,
    syncLiveDot() {},
    syncChatTitle() {},
    onWorkspaceFileWritten() {},
    approvalCards: { mount() {}, beginRun() {}, reset() {} },
  });

  // Ein Chat, wie er nach dem Oeffnen aus dem Verlauf dasteht.
  appStore.currentChatId = GEFUEHRT.id;
  appStore.currentChatWorkspace = null;
  appStore.currentChatTitle = GEFUEHRT.title;
  appStore.chatMessages = GEFUEHRT.messages.map((m) => ({ ...m }));

  return { chat, appStore, upserts, cleanup: dom.cleanup };
}

test('a chat that is only looked at is not written when the folder\'s chat is shown', async (t) => {
  const { chat, upserts, cleanup } = await mountChat();
  t.after(cleanup);

  await chat.loadChatForWorkspace('/ws');

  assert.equal(upserts.length, 0);
});

test('"New chat" does not write the chat it leaves either', async (t) => {
  const { chat, upserts, cleanup } = await mountChat();
  t.after(cleanup);

  await chat.startNewChat();

  assert.equal(upserts.length, 0);
});

test('the renderer offers no way to write a chat', async (t) => {
  const { chat, cleanup } = await mountChat();
  t.after(cleanup);

  assert.equal('persistCurrentChat' in chat, false);
});
