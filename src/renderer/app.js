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
import { initChatHistoryDrawer } from './components/ChatHistoryDrawer.js';
import { initSettingsModal } from './components/SettingsModal.js';
import { initUpdateBanner } from './components/UpdateBanner.js';
import { initToolPermissionState } from './state/tool-permissions.js';
import { initToolModePicker } from './components/ToolModePicker.js';
import { initToolApprovalCards } from './components/ToolApprovalCard.js';
import { initToolPermissionsPanel } from './components/ToolPermissionsPanel.js';
import { initMcpPanel } from './components/McpPanel.js';
import { initAppVersionBadge } from './components/AppVersionBadge.js';

const api = window.electronAPI;
const DEFAULT_MAX_TOOL_ROUNDS = 14;

// app.js hält nur noch die Elemente, die es selbst bedient (Input-Höhe,
// Content-Pane-Toggle, Öffnen-Buttons) — alle anderen Selektoren leben in
// den jeweiligen Components.
const btnOpen = document.getElementById('btn-open-folder');
const workspace = document.getElementById('workspace');
const appRoot = document.getElementById('app');
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const btnToggleContentPane = document.getElementById('btn-toggle-content-pane');
const iconContentPaneVisible = document.getElementById('icon-content-pane-visible');
const iconContentPaneHidden = document.getElementById('icon-content-pane-hidden');
const chatInput = document.getElementById('chat-input');
const chatInputRow = document.getElementById('chat-input-row');
const btnChatNew = document.getElementById('btn-chat-new');

initTheme();

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
    workspace.classList.remove('workspace--no-preview');
    iconContentPaneVisible.classList.remove('hidden');
    iconContentPaneHidden.classList.add('hidden');
    btnToggleContentPane.title = 'Mittlere Vorschau ausblenden';
    btnToggleContentPane.setAttribute('aria-label', 'Mittlere Vorschau ausblenden');
    btnToggleContentPane.setAttribute('aria-pressed', 'true');
  } else {
    workspace.classList.add('workspace--no-preview');
    iconContentPaneVisible.classList.add('hidden');
    iconContentPaneHidden.classList.remove('hidden');
    btnToggleContentPane.title = 'Mittlere Vorschau einblenden';
    btnToggleContentPane.setAttribute('aria-label', 'Mittlere Vorschau einblenden');
    btnToggleContentPane.setAttribute('aria-pressed', 'false');
  }
}

btnToggleContentPane.addEventListener('click', async () => {
  const wasVisible = !workspace.classList.contains('workspace--no-preview');
  const visibleAfterToggle = !wasVisible;
  setContentPaneVisible(visibleAfterToggle);
  try {
    await api.setUIPrefs({ contentPaneVisible: visibleAfterToggle });
  } catch {
    setContentPaneVisible(wasVisible);
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
  const label = visible ? 'Seitenleiste ausblenden' : 'Seitenleiste einblenden';
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

const modelPicker = initChatModelPicker({ api, appStore });

// Tool-Berechtigungen (Issue #67): ein geteilter Stand für Chat-Pille und
// Einstellungen, Freigabe-Karten melden sich beim Main als Oberfläche an.
const toolPermissions = initToolPermissionState({ api });
initToolModePicker({ toolPermissions });
const approvalCards = initToolApprovalCards({ api, appStore });
const toolPermissionsPanel = initToolPermissionsPanel({ toolPermissions });
const mcpPanel = initMcpPanel({ api });

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
});

const chatHistory = initChatHistoryDrawer({
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
});

const updateBanner = initUpdateBanner({ api });

const settingsModal = initSettingsModal({
  api,
  appStore,
  stopChatVoiceListening: voice.stopChatVoiceListening,
  closeChatModelMenu: () => modelPicker.closeChatModelMenu(),
  refreshLLMState: () => modelPicker.refreshLLMState(),
  findProviderMeta: (id) => modelPicker.findProviderMeta(id),
  updateChatChrome: () => modelPicker.updateChatChrome(),
  onCheckUpdates: () => updateBanner.checkNow(),
  toolPermissionsPanel,
  mcpPanel,
  onSkillSuggestionModeChanged: (mode) => skillSuggestion.setMode(mode),
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
    await chatStream.loadChatForWorkspace(folderPath);
  },
  onProjectOpened: () => modelPicker.updateChatChrome(),
  sendChatMessage: () => chatStream.sendChatMessage(),
  activeProviderConfigured: () => modelPicker.activeProviderConfigured(),
  // @-Referenz aus dem Baum in die Chat-Eingabe (Issue #56); die Einfüge-Logik
  // bleibt beim Textfeld, der Baum liefert nur den Pfad.
  insertChatReference: (relPath, kind) => mentionAutocomplete.insertReference(relPath, kind),
});

fileTree.setHistoryDrawerCloseOnEscape(() => {
  if (chatHistory.isHistoryDrawerOpen()) {
    chatHistory.setHistoryDrawerOpen(false);
  }
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
  let uiPrefs = { contentPaneVisible: true, sidebarVisible: true, appLocale: 'de' };
  try {
    uiPrefs = await api.getUIPrefs();
    setContentPaneVisible(uiPrefs.contentPaneVisible !== false);
    // Beim Start ohne Animation: die Leiste soll gleich richtig stehen und
    // nicht erst ins Bild fahren.
    setSidebarVisible(uiPrefs.sidebarVisible !== false, { animate: false });
    skillSuggestion.setMode(uiPrefs.skillSuggestionMode);
    settingsModal.applyShellLocale(uiPrefs.appLocale === 'en' ? 'en' : 'de');
  } catch {
    setContentPaneVisible(true);
    setSidebarVisible(true, { animate: false });
  }
  initSidebarResizer({
    api,
    initialSidebarWidth: uiPrefs.sidebarWidth,
    initialChatPanelWidth: uiPrefs.chatPanelWidth,
  });
  const { folderPath } = await api.getLastFolder();
  // openProject meldet false, wenn der Main-Prozess den Ordner nicht mehr
  // aktiviert (geloescht, nicht mehr im Verlauf) — dann ohne Ordner starten.
  const opened = folderPath ? await fileTree.openProject(folderPath) : false;
  if (!opened) {
    await chatStream.loadChatForWorkspace(null);
    await fileTree.refreshWelcomeRecent();
    modelPicker.updateChatChrome();
  }
  syncChatInputHeight();
})();
