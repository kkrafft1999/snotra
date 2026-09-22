// Die beiden Spalten der rechten Fensterhaelfte am echten DOM.
//
// Chat und Verlauf werden seit dem Umbau genauso geschaltet wie Baum und
// Anzeige gegenueber: ueber die Titelzeile, mit aria-pressed am Knopf und einer
// Klasse an #app. Geprueft wird hier die Verdrahtung — dass der Knopf aus der
// Titelzeile wirklich diese Spalte meint, dass der Klick auf einen Verlauf den
// Chat zurueckholt (Spiegelbild zum Klick auf eine Datei im Baum) und dass der
// Resizer von jedem Wechsel erfaehrt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const SESSION = {
  id: 'chat-alt',
  title: 'Alter Chat',
  updatedAt: 10,
  workspaceRoot: null,
  messages: [{ role: 'user', content: 'Hallo' }],
};

async function setup() {
  const dom = setupRendererDom();
  const { initChatHistoryPanel } = await importRenderer('components', 'ChatHistoryPanel.js');
  const { appStore } = await importRenderer('state', 'store.js');

  const prefs = [];
  const visibility = [];
  let revealed = 0;
  let historyReads = 0;

  appStore.currentChatId = 'chat-aktuell';
  appStore.chatMessages = [];

  const panel = initChatHistoryPanel({
    api: {
      getChatHistory: async () => {
        historyReads += 1;
        return { sessions: [SESSION], activeChatId: null };
      },
      setActiveChatId: async () => ({ ok: true }),
      setUIPrefs: async (patch) => { prefs.push(patch); return { ok: true }; },
      deleteChatSession: async () => ({ ok: true }),
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
    onVisibilityChanged: (open, meta) => visibility.push({ open, ...meta }),
    revealChatPanel: () => { revealed += 1; },
  });

  return {
    dom,
    panel,
    appStore,
    prefs,
    visibility,
    revealCount: () => revealed,
    historyReads: () => historyReads,
    appRoot: dom.document.getElementById('app'),
    toggle: dom.document.getElementById('btn-toggle-chat-history'),
  };
}

test('der Schalter aus der Titelzeile blendet die Verlaufsspalte ein und wieder aus', async () => {
  const { appRoot, toggle, prefs } = await setup();

  assert.ok(appRoot.classList.contains('app--no-history'), 'startet zugeklappt');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');

  toggle.click();
  await flush();

  assert.ok(!appRoot.classList.contains('app--no-history'));
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Hide chat history');
  assert.deepEqual(prefs, [{ chatHistoryVisible: true }]);

  toggle.click();
  await flush();

  assert.ok(appRoot.classList.contains('app--no-history'));
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(prefs.at(-1), { chatHistoryVisible: false });
});

test('das automatische Wegklappen ueberschreibt den Wunsch des Nutzers nicht', async () => {
  const { panel, prefs, visibility } = await setup();

  panel.setHistoryOpen(true, { persist: false });

  assert.deepEqual(prefs, [], 'ein Platzmangel ist kein neuer Wunsch');
  assert.deepEqual(visibility, [{ open: true, persisted: false }]);
});

test('ein Klick im Verlauf holt die weggeschaltete Chat-Spalte zurueck', async () => {
  const { panel, appStore, revealCount } = await setup();

  await panel.openChatSession('chat-alt');
  await flush();

  assert.equal(revealCount(), 1, 'wie der Klick auf eine Datei die Anzeige zurueckholt');
  assert.equal(appStore.currentChatId, 'chat-alt');
});

test('derselbe Chat noch einmal angeklickt holt nichts zurueck', async () => {
  const { panel, appStore, revealCount } = await setup();
  appStore.currentChatId = 'chat-alt';

  await panel.openChatSession('chat-alt');
  await flush();

  assert.equal(revealCount(), 0);
});

test('eine Zeile im Verlauf oeffnet ihren Chat per Maus und per Tastatur', async () => {
  const { dom, panel, appStore, revealCount } = await setup();

  await panel.renderHistoryList();
  const row = dom.document.querySelector('.chat-history-row');
  assert.ok(row, 'die Liste muss eine Zeile haben');
  assert.equal(row.tabIndex, 0, 'die Zeile ist per Tabulator erreichbar');

  row.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await flush();

  assert.equal(appStore.currentChatId, 'chat-alt');
  assert.equal(revealCount(), 1);
});

test('nach einem Ordnerwechsel zieht die offene Spalte den Verlauf selbst nach', async () => {
  const { dom, panel, historyReads } = await setup();

  // Zugeklappt bleibt es bei der Arbeit, die man sieht: nichts.
  await panel.refreshIfOpen();

  assert.equal(historyReads(), 0);
  assert.equal(dom.document.querySelectorAll('.chat-history-row').length, 0);

  panel.setHistoryOpen(true, { persist: false });
  await panel.refreshIfOpen();

  assert.equal(historyReads(), 1);
  assert.equal(
    dom.document.querySelectorAll('.chat-history-row').length,
    1,
    'die Chats des Ordners stehen da, ohne dass jemand erst „Neuer Chat“ drueckt'
  );
});
