import { appStore } from './state/store.js';
import { initTheme } from './components/ThemeManager.js';
import { initSidebarResizer } from './components/SidebarResizer.js';
import { initFileTree } from './components/FileTree.js';
import { initWhisperRecorder } from './voice/WhisperRecorder.js';
import { initChatModelPicker } from './components/ChatModelPicker.js';
import { initChatStream } from './components/ChatStream.js';
import { initChatHistoryDrawer } from './components/ChatHistoryDrawer.js';
import { initSettingsModal } from './components/SettingsModal.js';
import { initUpdateBanner } from './components/UpdateBanner.js';

const api = window.electronAPI;
const DEFAULT_MAX_TOOL_ROUNDS = 14;

// app.js hält nur noch die Elemente, die es selbst bedient (Input-Höhe,
// Content-Pane-Toggle, Öffnen-Buttons) — alle anderen Selektoren leben in
// den jeweiligen Components.
const btnOpen = document.getElementById('btn-open-folder');
const workspace = document.getElementById('workspace');
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

const modelPicker = initChatModelPicker({ api, appStore });

const voice = initWhisperRecorder({
  api,
  onInputChanged: syncChatInputHeight,
});

const chatStream = initChatStream({
  api,
  appStore,
  onInputChanged: syncChatInputHeight,
  stopChatVoiceListening: voice.stopChatVoiceListening,
  activeProviderConfigured: () => modelPicker.activeProviderConfigured(),
  syncLiveDot: () => modelPicker.syncLiveDot(),
  onWorkspaceFileWritten: (relativePath) => fileTree.notifyExternalFileWrite(relativePath),
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
  DEFAULT_MAX_TOOL_ROUNDS,
});

const fileTree = initFileTree({
  api,
  appStore,
  onInputChanged: syncChatInputHeight,
  onWorkspaceChanged: async (folderPath) => {
    await chatStream.loadChatForWorkspace(folderPath);
  },
  onProjectOpened: () => modelPicker.updateChatChrome(),
  sendChatMessage: () => chatStream.sendChatMessage(),
  activeProviderConfigured: () => modelPicker.activeProviderConfigured(),
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

(async () => {
  let uiPrefs = { contentPaneVisible: true, appLocale: 'de' };
  try {
    uiPrefs = await api.getUIPrefs();
    setContentPaneVisible(uiPrefs.contentPaneVisible !== false);
    settingsModal.applyShellLocale(uiPrefs.appLocale === 'en' ? 'en' : 'de');
  } catch {
    setContentPaneVisible(true);
  }
  initSidebarResizer({
    api,
    initialSidebarWidth: uiPrefs.sidebarWidth,
    initialChatPanelWidth: uiPrefs.chatPanelWidth,
  });
  const { folderPath } = await api.getLastFolder();
  if (folderPath) {
    await fileTree.openProject(folderPath);
  } else {
    await chatStream.loadChatForWorkspace(null);
    await fileTree.refreshWelcomeRecent();
    modelPicker.updateChatChrome();
  }
  syncChatInputHeight();
})();
