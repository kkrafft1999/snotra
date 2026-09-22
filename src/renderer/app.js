import { appStore } from './state/store.js';
import { initTheme } from './components/ThemeManager.js';
import { initSidebarResizer } from './components/SidebarResizer.js';
import { initFileTree } from './components/FileTree.js';
import { initWhisperRecorder } from './voice/WhisperRecorder.js';
import { initChatModelPicker } from './components/ChatModelPicker.js';
import { initChatStream } from './components/ChatStream.js';
import { initMentionAutocomplete } from './components/MentionAutocomplete.js';
import { initSkillAutocomplete } from './components/SkillAutocomplete.js';
import { initSkillSuggestion } from './components/SkillSuggestion.js';
import { createSkillCatalogSource } from './chat/skillCatalogSource.js';
import { initChatHistoryPanel } from './components/ChatHistoryPanel.js';
import { initSettingsModal } from './components/SettingsModal.js';
import { initUpdateDialog } from './components/UpdateDialog.js';
import { initToolPermissionState } from './state/tool-permissions.js';
import { initToolModePicker } from './components/ToolModePicker.js';
import { initToolApprovalCards } from './components/ToolApprovalCard.js';
import { initToolPermissionsPanel } from './components/ToolPermissionsPanel.js';
import { initMcpPanel } from './components/McpPanel.js';
import { initMemoryPanel } from './components/MemoryPanel.js';
import { initAppVersionBadge } from './components/AppVersionBadge.js';
import { contentPaneVisibleOnStart } from './utils/startupLayout.js';
import { t, setLocale, onLocaleChange } from './i18n.js';

const api = window.electronAPI;
const DEFAULT_MAX_TOOL_ROUNDS = 14;

// app.js hält nur noch die Elemente, die es selbst bedient (Input-Höhe,
// Content-Pane-Toggle, Öffnen-Buttons) — alle anderen Selektoren leben in
// den jeweiligen Components.
const btnOpen = document.getElementById('btn-open-folder');
const appRoot = document.getElementById('app');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const btnToggleContentPane = document.getElementById('btn-toggle-content-pane');
const btnToggleChatPanel = document.getElementById('btn-toggle-chat-panel');
const chatInput = document.getElementById('chat-input');
const chatInputRow = document.getElementById('chat-input-row');
const btnChatNew = document.getElementById('btn-chat-new');

const theme = initTheme();

let syncInputHeightRaf = null;
function syncChatInputHeight() {
  if (syncInputHeightRaf !== null) return;
  syncInputHeightRaf = requestAnimationFrame(() => {
    syncInputHeightRaf = null;
    const el = chatInput;
    el.style.height = '0px';
    const h = el.scrollHeight;
    el.style.height = `${h}px`;
    if (chatInputRow) {
      chatInputRow.classList.toggle('chat-input-row--multiline', h > 52);
    }
  });
}

chatInput.addEventListener('input', syncChatInputHeight);
window.addEventListener('resize', syncChatInputHeight);
let chatInputRowResizeObserver = null;
if (typeof ResizeObserver !== 'undefined' && chatInputRow) {
  chatInputRowResizeObserver = new ResizeObserver(() => syncChatInputHeight());
  chatInputRowResizeObserver.observe(chatInputRow);
}

window.addEventListener('beforeunload', () => {
  if (syncInputHeightRaf !== null) {
    cancelAnimationFrame(syncInputHeightRaf);
    syncInputHeightRaf = null;
  }
  chatInputRowResizeObserver?.disconnect();
  if (sidebarAnimationTimer !== null) {
    clearTimeout(sidebarAnimationTimer);
    sidebarAnimationTimer = null;
  }
});

function setContentPaneVisible(visible) {
  if (visible) {
    appRoot.classList.remove('app--no-preview');
    btnToggleContentPane.title = t('titlebar.preview.hide');
    btnToggleContentPane.setAttribute('aria-label', t('titlebar.preview.hide'));
    btnToggleContentPane.setAttribute('aria-pressed', 'true');
  } else {
    appRoot.classList.add('app--no-preview');
    btnToggleContentPane.title = t('titlebar.preview.show');
    btnToggleContentPane.setAttribute('aria-label', t('titlebar.preview.show'));
    btnToggleContentPane.setAttribute('aria-pressed', 'false');
  }
}

// Die mittlere Spalte startet zu und klappt erst auf, wenn feststeht, dass kein
// Chat wiederhergestellt wird (Issue #208). Andersherum blitzte der Startschirm
// jedes Mal kurz auf und spraenge gleich wieder weg.
setContentPaneVisible(false);

// Beide Merker gehoeren nur dem Start: ob der geladene Ordner eine Konversation
// zurueckgebracht hat, und ob der Nutzer waehrend des Starts schon selbst
// geschaltet hat — dann hat seine Hand Vorrang.
let chatRestoredOnLoad = false;
let contentPaneToggledByUser = false;

function applyStartupContentPane({ preference, hasFolder, chatWidthRemembered }) {
  if (contentPaneToggledByUser) return;
  const visible = contentPaneVisibleOnStart({
    preference,
    chatRestored: chatRestoredOnLoad,
    hasFolder,
  });
  setContentPaneVisible(visible);
  // Ohne Ordner steht in der Spalte der Startschirm, und der braucht nicht
  // mehr als seine 624 px (Issue #258). Den Rest bekommt der Chat — ausser die
  // Breite ist gemerkt, dann gilt sie.
  if (visible && hasFolder !== true && !chatWidthRemembered) {
    panelResizer?.fitChatToWelcome();
  }
}

btnToggleContentPane.addEventListener('click', async () => {
  contentPaneToggledByUser = true;
  const wasVisible = !appRoot.classList.contains('app--no-preview');
  const visibleAfterToggle = !wasVisible;
  setContentPaneVisible(visibleAfterToggle);
  try {
    await api.setUIPrefs({ contentPaneVisible: visibleAfterToggle });
  } catch {
    setContentPaneVisible(wasVisible);
  }
});

// ── Chat-Spalte ein-/ausblenden ────────────────────────────────────────────
// Spiegelbild zur mittleren Anzeige: derselbe Mechanismus, dieselbe Klasse an
// #app, derselbe Knopf — nur auf der anderen Seite der Titelzeile. Bleibt der
// Chat weg, steht rechts nur noch der Verlauf.
function setChatPanelVisible(visible) {
  const label = t(visible ? 'titlebar.chat.hide' : 'titlebar.chat.show');
  appRoot.classList.toggle('app--no-chat', !visible);
  btnToggleChatPanel.title = label;
  btnToggleChatPanel.setAttribute('aria-label', label);
  btnToggleChatPanel.setAttribute('aria-pressed', visible ? 'true' : 'false');
  // Die Eingabezeile misst ihre Hoehe an sich selbst; weggeschaltet misst sie
  // 0. Ohne dieses Nachmessen kaeme sie einzeilig zurueck, auch wenn ein
  // langer Entwurf drinsteht.
  if (visible) syncChatInputHeight();
}

function revealChatPanel() {
  if (!appRoot.classList.contains('app--no-chat')) return;
  setChatPanelVisible(true);
  panelResizer?.ensureRoomForWorkspace();
  void api.setUIPrefs({ chatPanelVisible: true }).catch(() => {});
}

btnToggleChatPanel.addEventListener('click', async () => {
  const wasVisible = !appRoot.classList.contains('app--no-chat');
  const visibleAfterToggle = !wasVisible;
  setChatPanelVisible(visibleAfterToggle);
  panelResizer?.ensureRoomForWorkspace();
  try {
    await api.setUIPrefs({ chatPanelVisible: visibleAfterToggle });
  } catch {
    setChatPanelVisible(wasVisible);
    panelResizer?.ensureRoomForWorkspace();
  }
});

// ── Seitenleiste ein-/ausblenden (Issue #167) ──────────────────────────────
// Der Zustand steht am Knopf (aria-pressed) und an #app; das Aussehen kommt
// vollstaendig aus dem CSS. Das Kuerzel steht im Tooltip, weil der Knopf sonst
// nichts davon verraet — geschaltet wird es im Menue des Main-Prozesses.
const SIDEBAR_SHORTCUT = navigator.userAgent.includes('Mac') ? '\u2318B' : 'Strg+B';

// Nur fuer die Dauer des Umschaltens laeuft die Breiten-Transition; danach muss
// sie wieder weg, sonst haengt der Trenner beim Ziehen hinterher.
let sidebarAnimationTimer = null;
function runSidebarTransition() {
  appRoot.classList.add('app--sidebar-animating');
  if (sidebarAnimationTimer !== null) clearTimeout(sidebarAnimationTimer);
  // Etwas mehr als --ds-motion-medium (0,3 s) — transitionend feuert nicht
  // zuverlaessig, wenn der Wert sich rechnerisch nicht aendert.
  sidebarAnimationTimer = setTimeout(() => {
    sidebarAnimationTimer = null;
    appRoot.classList.remove('app--sidebar-animating');
  }, 360);
}

function setSidebarVisible(visible, { animate = true } = {}) {
  if (animate) runSidebarTransition();
  appRoot.classList.toggle('app--no-sidebar', !visible);
  const label = t(visible ? 'titlebar.sidebar.hide' : 'titlebar.sidebar.show');
  btnToggleSidebar.title = `${label} (${SIDEBAR_SHORTCUT})`;
  btnToggleSidebar.setAttribute('aria-label', label);
  btnToggleSidebar.setAttribute('aria-pressed', visible ? 'true' : 'false');
}

async function toggleSidebar() {
  const wasVisible = !appRoot.classList.contains('app--no-sidebar');
  const visibleAfterToggle = !wasVisible;
  setSidebarVisible(visibleAfterToggle);
  try {
    await api.setUIPrefs({ sidebarVisible: visibleAfterToggle });
  } catch {
    setSidebarVisible(wasVisible);
  }
}

btnToggleSidebar.addEventListener('click', () => {
  void toggleSidebar();
});

// Menue "Ansicht > Seitenleiste ein-/ausblenden" bzw. Cmd/Ctrl+B.
api.onToggleSidebar?.(() => {
  void toggleSidebar();
});

// The three column toggles carry their text in JavaScript, not in the markup —
// it depends on state. `applyTranslations` therefore does not catch them on a
// language change; this follow-up does (epic #277).
onLocaleChange(() => {
  setContentPaneVisible(!appRoot.classList.contains('app--no-preview'));
  setChatPanelVisible(!appRoot.classList.contains('app--no-chat'));
  setSidebarVisible(!appRoot.classList.contains('app--no-sidebar'), { animate: false });
});

const modelPicker = initChatModelPicker({ api, appStore });

// Tool-Berechtigungen (Issue #67): ein geteilter Stand für Chat-Pille und
// Einstellungen, Freigabe-Karten melden sich beim Main als Oberfläche an.
const toolPermissions = initToolPermissionState({ api });
initToolModePicker({ toolPermissions });
const approvalCards = initToolApprovalCards({ api, appStore });
const toolPermissionsPanel = initToolPermissionsPanel({ toolPermissions });
const mcpPanel = initMcpPanel({ api });
const memoryPanel = initMemoryPanel({ api });

/**
 * Chat wird zum aktiven (Issue #211): Der Main stellt Modell und Freigabemodus
 * dieses Chats her, danach ziehen die beiden Pillen nach. `activation` trennt
 * den ausdruecklichen Wechsel im Verlauf vom automatischen Wiederherstellen
 * beim Start oder Ordnerwechsel — nur der ausdrueckliche holt „Auto“ zurueck.
 */
async function activateChatSession(chatId, activation = 'explicit') {
  try {
    await api.activateChatSession?.(chatId, activation);
  } catch {
    // Bleibt es beim gerade eingestellten Modell und Modus, laeuft der Chat
    // weiter — die Pillen zeigen dann eben den unveraenderten Stand.
  }
  await Promise.all([modelPicker.refreshLLMState(), toolPermissions.refresh()]);
}

const voice = initWhisperRecorder({
  api,
  onInputChanged: syncChatInputHeight,
});

// @-Vervollständigung (Issue #52); hängt sich per Capture-Listener ans Eingabefeld,
// die Reihenfolge zu initChatStream ist daher unkritisch.
const mentionAutocomplete = initMentionAutocomplete({
  api,
  appStore,
  onInputChanged: syncChatInputHeight,
});

// Beide Skill-Teile im Chat lesen denselben Katalog (Issue #125).
const skillCatalog = createSkillCatalogSource({ api, appStore });

// /-Vervollstaendigung fuer Skills (Issue #124); wie die @-Variante per
// Capture-Listener, die beiden Listen schliessen sich durch ihre Suchmuster
// gegenseitig aus.
const skillAutocomplete = initSkillAutocomplete({
  catalog: skillCatalog,
  onInputChanged: syncChatInputHeight,
});

// Vorschlag unter dem Eingabefeld (Issue #125). Erscheint nur, solange eine
// „/“-Abfrage offen ist — die Liste steht ueber dem Feld, der Hinweis
// darunter.
const skillSuggestion = initSkillSuggestion({
  catalog: skillCatalog,
  api,
  onInputChanged: syncChatInputHeight,
  onApplied: () => skillAutocomplete.close(),
});

// Der Datei-Watcher im Main meldet neue, geaenderte und entfernte Skills
// (Issue #126). Liste und Vorschlag ziehen dadurch sofort nach, statt auf das
// Ablaufen der Cache-Frist zu warten (Issue #130) — die Liste bleibt dabei
// offen, falls die Meldung mitten in der Eingabe eintrifft.
skillCatalog.onInvalidated(() => {
  skillAutocomplete.refresh();
  skillSuggestion.refresh();
});
api.onSkillsChanged?.(() => skillCatalog.invalidate());

const chatStream = initChatStream({
  api,
  appStore,
  onInputChanged: syncChatInputHeight,
  stopChatVoiceListening: voice.stopChatVoiceListening,
  activeProviderConfigured: () => modelPicker.activeProviderConfigured(),
  activeProviderSupportsImages: () => modelPicker.activeProviderSupportsImages(),
  syncLiveDot: () => modelPicker.syncLiveDot(),
  syncChatTitle: () => modelPicker.syncChatTitle(),
  onWorkspaceFileWritten: (relativePath) => {
    mentionAutocomplete.invalidate();
    return fileTree.notifyExternalFileWrite(relativePath);
  },
  approvalCards,
  // Sprung von einer Skill-Zeile der Token-Aufschlüsselung zu ihrem Schalter
  // (Issue #174). settingsModal entsteht weiter unten — der Aufruf passiert
  // erst zur Laufzeit.
  openSkillSettings: (skillName) => settingsModal.openSettingsModal({ panel: 'skills', skillName }),
  activateChatSession,
  // Steht die Verlaufsspalte offen, soll sie den neuen Titel und den neuen
  // Zeitpunkt gleich zeigen statt erst beim naechsten Einblenden.
  onChatPersisted: () => {
    if (chatHistory.isHistoryOpen()) void chatHistory.renderHistoryList();
  },
});

// Der Resizer entsteht erst in der Startsequenz, der Verlauf braucht ihn aber
// schon beim ersten Umschalten — deshalb ueber diesen Merker statt direkt.
let panelResizer = null;

const chatHistory = initChatHistoryPanel({
  api,
  appStore,
  stopChatVoiceListening: voice.stopChatVoiceListening,
  persistCurrentChat: chatStream.persistCurrentChat,
  renderChatMessages: chatStream.renderChatMessages,
  updateChatChrome: () => modelPicker.updateChatChrome(),
  onInputChanged: syncChatInputHeight,
  setChatTokenUsage: (usage) => chatStream.setChatTokenUsage(usage),
  resetChatTokenUsage: () => chatStream.resetChatTokenUsage(),
  seedGreetingIfWorkspace: (workspaceRoot) => chatStream.seedGreetingIfWorkspace(workspaceRoot),
  activateChatSession,
  onNewChatStarted: async () => {
    await chatStream.startNewChat();
    modelPicker.updateChatChrome();
  },
  // Nach dem Umschalten teilt der Resizer die Breiten neu auf — sonst stuende
  // die neue Spalte ueber dem Arbeitsbereich.
  onVisibilityChanged: (_open, meta) => panelResizer?.handleHistoryVisibility(meta),
  // Wer einen Chat im Verlauf anklickt, will ihn sehen — genau wie der Klick
  // auf eine Datei die mittlere Spalte zurueckholt.
  revealChatPanel,
});

const updateDialog = initUpdateDialog({ api });

const settingsModal = initSettingsModal({
  api,
  appStore,
  stopChatVoiceListening: voice.stopChatVoiceListening,
  closeChatModelMenu: () => modelPicker.closeChatModelMenu(),
  refreshLLMState: () => modelPicker.refreshLLMState(),
  findProviderMeta: (id) => modelPicker.findProviderMeta(id),
  updateChatChrome: () => modelPicker.updateChatChrome(),
  onCheckUpdates: () => updateDialog.checkNow(),
  toolPermissionsPanel,
  mcpPanel,
  memoryPanel,
  onSkillSuggestionModeChanged: (mode) => skillSuggestion.setMode(mode),
  getTheme: theme.getTheme,
  setTheme: theme.setTheme,
  DEFAULT_MAX_TOOL_ROUNDS,
});

// Grundrauschen gegen den Chromium-Default (Issue #101): ein Drop *neben*
// der Drop-Zone im Dateibaum darf die Datei nicht im Fenster oeffnen. Bewusst
// nur fuer Dateien — Text irgendwohin zu ziehen (etwa in die Chat-Eingabe)
// bleibt die normale Browser-Geste. Die Drop-Zonen im Baum rufen selbst
// preventDefault(); dieser Handler laeuft am Dokument zuletzt und aendert
// daran nichts. Der will-navigate-Handler im Main-Prozess (src/main/window.js)
// bleibt das Netz darunter, ist aber nicht der eigentliche Schutz.
const dragCarriesFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if (dragCarriesFiles(e)) e.preventDefault();
  });
}

const fileTree = initFileTree({
  api,
  appStore,
  onInputChanged: syncChatInputHeight,
  onWorkspaceChanged: async (folderPath) => {
    mentionAutocomplete.invalidate();
    // Ordner-Skills haengen am Workspace, der Katalog ist damit hinfaellig.
    skillCatalog.invalidate();
    skillAutocomplete.close();
    skillSuggestion.hide();
    const loaded = await chatStream.loadChatForWorkspace(folderPath);
    chatRestoredOnLoad = loaded?.restored === true;
    // Der Verlauf ist nach Ordnern gebucht — der neue Ordner bringt eine
    // andere Liste mit. Ohne dieses Nachziehen stuenden dort die Chats des
    // vorigen Ordners, beim Start gar keine.
    await chatHistory.refreshIfOpen();
  },
  onProjectOpened: () => modelPicker.updateChatChrome(),
  sendChatMessage: () => chatStream.sendChatMessage(),
  activeProviderConfigured: () => modelPicker.activeProviderConfigured(),
  // @-Referenz aus dem Baum in die Chat-Eingabe (Issue #56); die Einfüge-Logik
  // bleibt beim Textfeld, der Baum liefert nur den Pfad.
  insertChatReference: (relPath, kind) => mentionAutocomplete.insertReference(relPath, kind),
  // Wer eine Datei anklickt, will sie sehen — auch wenn die mittlere Spalte
  // gerade zu ist (Issue #208).
  revealContentPane: () => {
    contentPaneToggledByUser = true;
    setContentPaneVisible(true);
  },
});

async function openFolderViaDialog() {
  const folderPath = await api.openFolder();
  if (folderPath) {
    await fileTree.openProject(folderPath);
  }
}

btnOpen.addEventListener('click', openFolderViaDialog);

const welcomeCta = document.getElementById('welcome-cta');
if (welcomeCta) {
  welcomeCta.addEventListener('click', openFolderViaDialog);
}

btnChatNew.addEventListener('click', () => chatHistory.startNewChatWithHistory());

modelPicker.refreshLLMState();
void toolPermissions.refresh();
void initAppVersionBadge({ api });

(async () => {
  let uiPrefs = {
    // Faellt das Lesen der Prefs aus, bleibt `contentPaneVisible` ungesetzt —
    // genau wie im Contract, wenn nichts gespeichert ist (Issues #255, #258).
    // Der Start entscheidet dann am Ordner.
    sidebarVisible: true,
    chatPanelVisible: true,
  };
  try {
    uiPrefs = await api.getUIPrefs();
    // Beim Start ohne Animation: die Leiste soll gleich richtig stehen und
    // nicht erst ins Bild fahren.
    setSidebarVisible(uiPrefs.sidebarVisible !== false, { animate: false });
    // Der gemerkte Zustand ist kein neuer Wunsch — deshalb nicht zurueck-
    // schreiben. Gefuellt wird die Liste hier noch nicht: Welcher Ordner aktiv
    // ist, entscheidet sich erst weiter unten, und vorher liefert der Verlauf
    // nichts. Das Nachziehen uebernimmt `refreshIfOpen` nach dem Oeffnen.
    if (uiPrefs.chatHistoryVisible === true) {
      chatHistory.setHistoryOpen(true, { persist: false });
    }
    // Der Chat startet sichtbar, ausser der Nutzer hat ihn weggeschaltet.
    // Kein Zurueckschreiben: Der gemerkte Stand ist kein neuer Wunsch.
    setChatPanelVisible(uiPrefs.chatPanelVisible !== false);
    skillSuggestion.setMode(uiPrefs.skillSuggestionMode);
    setLocale(uiPrefs.appLocale);
  } catch {
    setSidebarVisible(true, { animate: false });
  }
  panelResizer = initSidebarResizer({
    api,
    initialSidebarWidth: uiPrefs.sidebarWidth,
    initialChatPanelWidth: uiPrefs.chatPanelWidth,
    initialChatHistoryWidth: uiPrefs.chatHistoryWidth,
    // Wird es zu eng, klappt die Spalte weg und im breiteren Fenster wieder
    // auf — ohne den gemerkten Wunsch des Nutzers zu ueberschreiben.
    setHistoryVisible: (open) => chatHistory.setHistoryOpen(open, { persist: false }),
  });
  panelResizer.ensureRoomForWorkspace();
  // Ob am Ende ein Ordner offen ist, entscheidet ueber den Startschirm — und
  // damit ueber die Spalte (Issue #258). Deshalb vor dem try, es wird im
  // finally gebraucht.
  let folderOpened = false;
  try {
    const { folderPath } = await api.getLastFolder();
    // openProject meldet false, wenn der Main-Prozess den Ordner nicht mehr
    // aktiviert (geloescht, nicht mehr im Verlauf) — dann ohne Ordner starten.
    folderOpened = folderPath ? await fileTree.openProject(folderPath) : false;
    if (!folderOpened) {
      const loaded = await chatStream.loadChatForWorkspace(null);
      chatRestoredOnLoad = loaded?.restored === true;
      await fileTree.refreshWelcomeRecent();
      modelPicker.updateChatChrome();
      // Ohne Ordner laeuft kein `onWorkspaceChanged` — die Liste der Chats
      // ohne Workspace muss hier selbst angestossen werden.
      await chatHistory.refreshIfOpen();
    }
  } finally {
    // Erst jetzt steht fest, ob ein Chat zurueckgekommen ist — vorher waere die
    // Spalte nur geraten. Im `finally`, damit sie auch nach einem Fehler beim
    // Laden nicht eingeklappt haengen bleibt.
    applyStartupContentPane({
      preference: uiPrefs.contentPaneVisible,
      hasFolder: folderOpened,
      chatWidthRemembered: typeof uiPrefs.chatPanelWidth === 'number',
    });
  }
  syncChatInputHeight();
})();
