import { formatHistoryTime } from '../chat/messageUtils.js';
import { t, onLocaleChange } from '../i18n.js';

/**
 * Der Chat-Verlauf als Spalte neben dem Chat (Epic #223, Phase B).
 *
 * Bis 1.7.0 war er ein Ausklapper ueber den Nachrichten: Er schob den Chat nach
 * unten, ging beim Klick daneben und bei Escape wieder zu und war nach jeder
 * Auswahl weg. Als Spalte bleibt er stehen — man sieht den laufenden Chat und
 * die Liste gleichzeitig, und das Umschalten kostet keine Gedaechtnisleistung
 * mehr. Deshalb schliesst hier nichts mehr von selbst.
 *
 * Ein- und ausgeblendet wird die Spalte inzwischen wie ihre drei Geschwister
 * ueber die Titelzeile; in der Kopfzeile des Verlaufs steht stattdessen der
 * Knopf fuer einen neuen Chat — so wie "Ordner oeffnen" in der Kopfzeile des
 * Baums steht.
 */
const NO_RUNS = Object.freeze({
  detach: () => {},
  canAttach: () => false,
  attach: () => false,
  afterSwitch: () => {},
  discard: () => {},
  stateOf: () => null,
});

// Which run state a row shows, and the words for it. The words are part of the
// row's accessible name too — the dot alone would say nothing to a screen
// reader (WCAG 1.4.1).
const RUN_STATE_LABELS = Object.freeze({
  running: 'history.entry.running',
  awaiting: 'history.entry.awaiting',
});

export function initChatHistoryPanel({
  api,
  appStore,
  stopChatVoiceListening,
  persistCurrentChat,
  renderChatMessages,
  updateChatChrome,
  onInputChanged,
  setChatTokenUsage,
  resetChatTokenUsage,
  seedGreetingIfWorkspace,
  onNewChatStarted,
  // Modell und Freigabemodus des Chats herstellen (Issue #211).
  activateChatSession = async () => {},
  // Nach dem Ein- oder Ausblenden teilt der Resizer die Breiten neu auf.
  onVisibilityChanged = () => {},
  // Wer einen Chat aus dem Verlauf anklickt, will ihn sehen — auch wenn die
  // Chat-Spalte gerade zu ist (Spiegelbild zum Klick auf eine Datei im Baum).
  revealChatPanel = () => {},
  // Runs per chat (#320): a chat that is still running opens from memory, a
  // deleted one stops, and its row says whether it is working or waiting.
  runs = NO_RUNS,
}) {
  const appRoot = document.getElementById('app');
  const chatHistoryList = document.getElementById('chat-history-list');
  const chatHistoryEmpty = document.getElementById('chat-history-empty');
  // Der Schalter steht in der Titelzeile, gespiegelt zu denen der linken
  // Haelfte — nicht mehr in der Kopfzeile des Chats.
  const btnChatHistory = document.getElementById('btn-toggle-chat-history');

  function isHistoryOpen() {
    return !appRoot.classList.contains('app--no-history');
  }

  /**
   * `persist: false` beim Herstellen des gemerkten Zustands und beim
   * automatischen Wegklappen im zu schmalen Fenster — was der Nutzer zuletzt
   * wollte, soll ein Platzmangel nicht ueberschreiben.
   */
  function setHistoryOpen(open, { persist = true } = {}) {
    appRoot.classList.toggle('app--no-history', !open);
    const label = open ? t('titlebar.history.hide') : t('titlebar.history.show');
    // aria-pressed statt aria-expanded: Der Knopf schaltet eine Spalte, er
    // klappt nichts aus — genau wie seine drei Nachbarn in der Titelzeile.
    btnChatHistory?.setAttribute('aria-pressed', open ? 'true' : 'false');
    btnChatHistory?.setAttribute('aria-label', label);
    if (btnChatHistory) btnChatHistory.title = label;
    onVisibilityChanged(open, { persisted: persist });
    if (persist) void api.setUIPrefs({ chatHistoryVisible: open }).catch(() => {});
  }

  async function renderHistoryList() {
    const hist = await api.getChatHistory();
    const sessions = Array.isArray(hist.sessions) ? [...hist.sessions] : [];
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    chatHistoryList.innerHTML = '';
    if (sessions.length === 0) {
      chatHistoryEmpty.classList.remove('hidden');
      return;
    }
    chatHistoryEmpty.classList.add('hidden');
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'chat-history-row';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      if (s.id === appStore.currentChatId) row.classList.add('chat-history-row--current');
      const main = document.createElement('div');
      main.className = 'chat-history-row-main';
      const titleEl = document.createElement('span');
      titleEl.className = 'chat-history-row-title';
      titleEl.textContent = s.title || t('history.entry.fallbackTitle');
      const meta = document.createElement('span');
      meta.className = 'chat-history-row-meta';
      const time = document.createElement('span');
      time.className = 'chat-history-row-time';
      time.textContent = formatHistoryTime(s.updatedAt);
      meta.appendChild(time);
      main.appendChild(titleEl);
      main.appendChild(meta);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chat-history-row-delete';
      del.title = t('history.entry.remove');
      del.setAttribute('aria-label', t('history.entry.remove'));
      del.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
      row.appendChild(main);
      row.appendChild(del);
      row.dataset.chatId = s.id;
      applyRunState(row, runs.stateOf(s.id));

      const openThis = () => openChatSession(s.id);
      row.addEventListener('click', (e) => {
        if (e.target.closest('.chat-history-row-delete')) return;
        openThis();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openThis();
        }
      });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeChatFromHistory(s.id);
      });
      chatHistoryList.appendChild(row);
    }
  }

  /**
   * Der Verlauf haengt am aktiven Ordner: `getChatHistory` liefert nur die
   * Chats des Workspace, den der Main-Prozess gerade fuehrt (Issue #68).
   * Beim Start steht der aber erst fest, nachdem der zuletzt benutzte Ordner
   * aktiviert wurde — eine Liste, die davor gezeichnet wird, bleibt leer und
   * fuellte sich bisher erst beim naechsten Anlass (neuer Chat, Ein- und
   * Ausblenden). Deshalb wird sie nach jedem Ordnerwechsel nachgezogen.
   * Ist die Spalte zu, genuegt das Rendern beim naechsten Einblenden.
   */
  async function refreshIfOpen() {
    if (!isHistoryOpen()) return;
    await renderHistoryList();
  }

  async function openChatSession(id) {
    if (!id || id === appStore.currentChatId) return;
    // Erst die Spalte, dann der Inhalt: Sonst liefe das Rendern in eine
    // weggeschaltete Flaeche und die Eingabezeile kaeme ohne Hoehe zurueck.
    revealChatPanel();
    stopChatVoiceListening();
    await persistCurrentChat();
    appStore.chatSessionId += 1;
    // A chat whose run is still in memory opens from there (#320): the file
    // only knows the state from when the run left the screen.
    let s = null;
    if (!runs.canAttach(id)) {
      const hist = await api.getChatHistory();
      s = hist.sessions?.find((x) => x.id === id);
      if (!s || !Array.isArray(s.messages)) return;
    }
    // The chat on screen takes its run into the background.
    runs.detach();
    if (!runs.attach(id)) {
      appStore.currentChatId = id;
      appStore.currentChatWorkspace = s.workspaceRoot || null;
      appStore.chatMessages = s.messages;
      appStore.currentChatTitle = s.title || '';
      setChatTokenUsage?.(s.tokenUsage);
    }
    onInputChanged();
    await api.setActiveChatId(id);
    // Ausdruecklicher Wechsel: Dieser Chat bekommt sein Modell und seinen
    // Freigabemodus zurueck — auch „Auto“, das er nur nach einer nativen
    // Bestaetigung tragen kann (Issue #211).
    await activateChatSession(id, 'explicit');
    renderChatMessages();
    runs.afterSwitch();
    updateChatChrome();
    await renderHistoryList();
  }

  async function removeChatFromHistory(id) {
    // First the run: it must not write the chat back once it is gone (#320).
    runs.discard(id);
    await api.deleteChatSession(id);
    if (id === appStore.currentChatId) {
      stopChatVoiceListening();
      appStore.chatSessionId += 1;
      appStore.currentChatId = crypto.randomUUID();
      appStore.currentChatWorkspace = appStore.rootPath || null;
      appStore.chatMessages = [];
      appStore.currentChatTitle = '';
      seedGreetingIfWorkspace?.(appStore.currentChatWorkspace);
      resetChatTokenUsage?.();
      onInputChanged();
      await api.setActiveChatId(null);
      // Der Ersatz ist ein neuer Chat: Standard-Modell, Modus „Intelligent“.
      await activateChatSession(appStore.currentChatId, 'explicit');
      renderChatMessages();
      updateChatChrome();
    }
    runs.afterSwitch();
    await renderHistoryList();
  }

  /**
   * Marks a row as running or waiting for an approval (#320). The state goes
   * into the meta line in place of the time — shape, colour and words
   * together, so it is never carried by colour alone.
   */
  function applyRunState(row, state) {
    const meta = row.querySelector('.chat-history-row-meta');
    if (!meta) return;
    const label = RUN_STATE_LABELS[state] ? t(RUN_STATE_LABELS[state]) : '';
    const shown = meta.querySelector('.chat-history-row-run');
    // Unchanged: leave the node alone, so the pulse does not restart.
    if ((row.dataset.runState || '') === (label ? state : '') && (shown?.textContent || '') === label) return;
    shown?.remove();
    if (!label) {
      delete row.dataset.runState;
      return;
    }
    row.dataset.runState = state;
    const run = document.createElement('span');
    run.className = 'chat-history-row-run';
    const dot = document.createElement('span');
    dot.className = 'chat-history-row-run-dot';
    dot.setAttribute('aria-hidden', 'true');
    run.appendChild(dot);
    run.append(label);
    meta.prepend(run);
  }

  /** Re-reads the run state of every row without fetching the history again. */
  function syncRunMarkers() {
    for (const row of chatHistoryList.querySelectorAll('.chat-history-row[data-chat-id]')) {
      applyRunState(row, runs.stateOf(row.dataset.chatId));
    }
  }

  async function startNewChatWithHistory() {
    await onNewChatStarted();
    await renderHistoryList();
  }

  btnChatHistory?.addEventListener('click', async () => {
    const open = !isHistoryOpen();
    if (open) await renderHistoryList();
    setHistoryOpen(open);
  });

  // Language change (epic #277): the button text depends on state and the rows
  // are built here — `applyTranslations` reaches neither.
  onLocaleChange(() => {
    setHistoryOpen(isHistoryOpen(), { persist: false });
    void refreshIfOpen();
  });

  return {
    isHistoryOpen,
    setHistoryOpen,
    renderHistoryList,
    refreshIfOpen,
    openChatSession,
    removeChatFromHistory,
    startNewChatWithHistory,
    syncRunMarkers,
  };
}
