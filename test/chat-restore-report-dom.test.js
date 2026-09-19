// Was loadChatForWorkspace() dem Start meldet (Issue #208).
//
// Die Auswahl selbst prueft test/chat-restore-selection.test.js DOM-frei. Hier
// geht es um die Auskunft danach: app.js richtet die mittlere Spalte daran aus,
// ob eine Konversation zurueckgekommen ist — meldet der Chat das falsch, steht
// der Startschirm neben einem laufenden Gespraech (oder fehlt, wo er hingehoert).

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

async function mountChat(history) {
  const dom = setupRendererDom();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');

  appStore.chatMessages = [];
  appStore.currentChatId = null;
  appStore.currentChatTitle = '';

  const api = {
    onChatDelta: () => {},
    onChatProgress: () => {},
    onChatToolLine: () => {},
    getChatHistory: async () => history,
    setActiveChatId: async () => {},
    upsertChatSession: async () => ({ ok: true }),
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
  return { chat, appStore, cleanup: dom.cleanup };
}

test('eine wiederhergestellte Konversation meldet sich als solche', async (t) => {
  const { chat, appStore, cleanup } = await mountChat({
    sessions: [
      { id: 'a', updatedAt: 10, title: 'Alt', messages: [{ role: 'user', content: 'hallo' }] },
    ],
    activeChatId: 'a',
  });
  t.after(cleanup);

  assert.deepEqual(await chat.loadChatForWorkspace('/ws'), { restored: true, wasActive: true });
  assert.equal(appStore.currentChatId, 'a');
});

test('ein leerer Ordner meldet keinen Chat', async (t) => {
  const { chat, cleanup } = await mountChat({ sessions: [], activeChatId: null });
  t.after(cleanup);

  assert.deepEqual(await chat.loadChatForWorkspace('/ws'), { restored: false, wasActive: false });
});

test('die Begruessung eines frischen Chats zaehlt nicht als Konversation', async (t) => {
  // Ohne aktive ID und ohne Nachrichten bleibt nur der Gruss im Fenster — der
  // Startschirm gehoert in diesem Fall daneben.
  const { chat, appStore, cleanup } = await mountChat({
    sessions: [{ id: 'leer', updatedAt: 99, messages: [] }],
    activeChatId: 'leer',
  });
  t.after(cleanup);

  const result = await chat.loadChatForWorkspace('/ws');
  assert.equal(result.restored, false);
  assert.ok(appStore.chatMessages.every((m) => m.greeting));
});
