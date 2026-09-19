// Der Chatwechsel am echten DOM (Issue #211).
//
// test/chat-session-settings.test.js prüft, *welche* Werte ein Chat bekommt.
// Hier geht es um die Verdrahtung davor: dass der Verlauf-Eintrag, der neue
// Chat und das automatische Wiederherstellen den Main überhaupt anstoßen — und
// mit welcher Art von Wechsel. Genau das fehlte: Ein Eintrag aus dem Verlauf
// kam mit seinen Nachrichten zurück, lief aber mit dem zuletzt eingestellten
// Modell weiter.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const SESSION = {
  id: 'chat-alt',
  title: 'Alter Chat',
  updatedAt: 10,
  workspaceRoot: null,
  messages: [{ role: 'user', content: 'Hallo' }],
  tokenUsage: { prompt: 1, completion: 1, total: 2 },
};

async function setup() {
  setupRendererDom();
  const { initChatHistoryDrawer } = await importRenderer('components', 'ChatHistoryDrawer.js');
  const { appStore } = await importRenderer('state', 'store.js');

  const activations = [];
  const api = {
    getChatHistory: async () => ({ sessions: [SESSION], activeChatId: null }),
    setActiveChatId: async () => ({ ok: true }),
    deleteChatSession: async () => ({ ok: true }),
    activateChatSession: async (chatId, activation) => {
      activations.push({ chatId, activation });
      return { ok: true };
    },
  };

  appStore.currentChatId = 'chat-aktuell';
  appStore.chatMessages = [];
  appStore.currentChatTitle = '';

  const drawer = initChatHistoryDrawer({
    api,
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
    activateChatSession: (chatId, activation) => api.activateChatSession(chatId, activation),
  });
  return { drawer, appStore, activations };
}

test('ein Eintrag aus dem Verlauf stellt Modell und Modus dieses Chats her', async () => {
  const { drawer, appStore, activations } = await setup();

  await drawer.openChatSession('chat-alt');
  await flush();

  assert.equal(appStore.currentChatId, 'chat-alt');
  assert.deepEqual(activations, [{ chatId: 'chat-alt', activation: 'explicit' }]);
});

test('derselbe Chat noch einmal angeklickt stellt nichts neu her', async () => {
  const { drawer, appStore, activations } = await setup();
  appStore.currentChatId = 'chat-alt';

  await drawer.openChatSession('chat-alt');
  await flush();

  assert.deepEqual(activations, []);
});

test('nach dem Löschen des offenen Chats gilt wieder der Standard', async () => {
  const { drawer, appStore, activations } = await setup();
  appStore.currentChatId = 'chat-alt';

  await drawer.removeChatFromHistory('chat-alt');
  await flush();

  assert.equal(activations.length, 1);
  assert.equal(activations[0].activation, 'explicit');
  // Der Ersatz ist ein frischer Chat, nicht der gelöschte.
  assert.equal(activations[0].chatId, appStore.currentChatId);
  assert.notEqual(activations[0].chatId, 'chat-alt');
});
