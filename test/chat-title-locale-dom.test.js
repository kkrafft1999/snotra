// Fallback chat titles in the interface language, on the real DOM (#359).
//
// A chat whose first message has no text has no title of its own. The history
// list shows one anyway — "New chat", "Image", "2 images" — and it has to be in
// the language of the interface, including for chats that an older version
// stored with a finished German title.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const IMAGE = { kind: 'image', mediaType: 'image/png', file: `${'d'.repeat(64)}.png`, bytes: 512 };

const SESSIONS = [
  // Stored after #359: no fallback title at all.
  { id: 'new-image', title: '', updatedAt: 40, workspaceRoot: null,
    messages: [{ role: 'user', content: '', attachments: [IMAGE] }] },
  // Stored before #359, German fallbacks.
  { id: 'old-images', title: '2 Bilder', updatedAt: 30, workspaceRoot: null,
    messages: [{ role: 'user', content: '', attachments: [IMAGE, IMAGE] }] },
  { id: 'old-empty', title: 'Neuer Chat', updatedAt: 20, workspaceRoot: null,
    messages: [{ role: 'user', content: '' }] },
  // A title of its own stays as it is, in whatever language it was written.
  { id: 'named', title: 'Wie starte ich die App?', updatedAt: 10, workspaceRoot: null,
    messages: [{ role: 'user', content: 'Wie starte ich die App?' }] },
];

async function setup(locale) {
  setupRendererDom();
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale, { force: true });
  const { initChatHistoryPanel } = await importRenderer('components', 'ChatHistoryPanel.js');
  const { appStore } = await importRenderer('state', 'store.js');
  appStore.currentChatId = null;
  appStore.chatMessages = [];
  appStore.currentChatTitle = '';

  const panel = initChatHistoryPanel({
    api: {
      getChatHistory: async () => ({ sessions: SESSIONS, activeChatId: null }),
      setActiveChatId: async () => ({ ok: true }),
      setUIPrefs: async () => ({ ok: true }),
      deleteChatSession: async () => ({ ok: true }),
      activateChatSession: async () => ({ ok: true }),
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
    activateChatSession: async () => ({ ok: true }),
  });
  return { panel, setLocale };
}

function rowTitles() {
  return [...document.querySelectorAll('.chat-history-row-title')].map((el) => el.textContent);
}

test('the history names untitled chats in English in the English interface', async () => {
  const { panel } = await setup('en');
  await panel.renderHistoryList();
  await flush();
  assert.deepEqual(rowTitles(), ['Image', '2 images', 'New chat', 'Wie starte ich die App?']);
});

test('the same chats read German in the German interface, and follow a switch', async () => {
  const { panel, setLocale } = await setup('de');
  panel.setHistoryOpen(true, { persist: false });
  await panel.renderHistoryList();
  await flush();
  assert.deepEqual(rowTitles(), ['Bild', '2 Bilder', 'Neuer Chat', 'Wie starte ich die App?']);

  setLocale('en');
  await flush();
  assert.deepEqual(rowTitles(), ['Image', '2 images', 'New chat', 'Wie starte ich die App?']);
});
