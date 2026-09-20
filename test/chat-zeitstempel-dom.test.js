// Wer den Zeitpunkt eines Chats setzt (Issue #245).
//
// Das Datum im Verlauf soll sagen, wann der Chat gefuehrt wurde. Frueher
// stempelte der Renderer bei jedem Schreiben — und er schreibt den abgehenden
// Chat auch dann, wenn man ihn nur angesehen hat. Ein alter Chat wanderte so
// auf „heute“ und nach oben, ohne dass ein Wort gefallen waere.
//
// Geprueft wird hier die Verdrahtung: dass die Nutzlast aus dem Renderer
// ueberhaupt keinen Zeitpunkt mehr traegt. Was der Main daraus macht, prueft
// test/chat-history-handlers.test.js.

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
    onChatDelta: () => {},
    onChatProgress: () => {},
    onChatToolLine: () => {},
    getChatHistory: async () => ({ sessions, activeChatId }),
    setActiveChatId: async () => {},
    upsertChatSession: async (row) => {
      upserts.push(row);
      return { ok: true };
    },
    generateChatTitle: async () => ({ title: '' }),
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

test('der Renderer sichert den abgehenden Chat ohne Zeitpunkt', async (t) => {
  const { chat, upserts, cleanup } = await mountChat();
  t.after(cleanup);

  await chat.loadChatForWorkspace('/ws');

  assert.equal(upserts.length, 1, 'der angesehene Chat wird weiterhin gesichert');
  assert.equal(upserts[0].id, 'chat-alt');
  assert.ok(!('updatedAt' in upserts[0]), 'aber ohne eigenen Zeitstempel');
  assert.deepEqual(
    upserts[0].messages.map((m) => m.content),
    ['Hallo', 'Guten Tag'],
    'der Nachrichtenstand geht unveraendert mit — daran erkennt der Main den Zug'
  );
});

test('auch „Neuer Chat“ sichert den abgehenden Chat ohne Zeitpunkt', async (t) => {
  const { chat, upserts, cleanup } = await mountChat();
  t.after(cleanup);

  await chat.startNewChat();

  assert.equal(upserts.length, 1);
  assert.ok(!('updatedAt' in upserts[0]));
});

test('ein nachgezogener Titel geht ebenfalls ohne Zeitpunkt hinaus', async (t) => {
  const { chat, appStore, upserts, cleanup } = await mountChat();
  t.after(cleanup);

  appStore.currentChatTitle = 'Vom Modell benannt';
  await chat.persistCurrentChat();

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].title, 'Vom Modell benannt');
  assert.ok(!('updatedAt' in upserts[0]));
});
