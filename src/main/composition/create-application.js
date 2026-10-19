'use strict';

const nodeOs = require('os');

const { registerModelPriceHandlers } = require('../ipc/model-price-handlers');
const { createUpdateService } = require('../services/update-service');
const { bundledSystemSkillsDir } = require('../services/skills-service');
const { KEY_ALWAYS_DURABLE } = require('../services/safe-storage-key-durability');
const { createNativeConfirmationAdapter } = require('../electron/native-confirmation-adapter');
const { createConfirmationReceipts } = require('../../application/permissions/user-confirmation');
const { createSystemNotificationAdapter } = require('../electron/system-notification-adapter');
const { createSafeStorageSecretStore } = require('../electron/safe-storage-backend');
const { resolveRunningPlatform } = require('../platforms/running-platform');
const { createUpdateAdapter, createUpdateCheck } = require('../adapters/update-adapter');
const { registerDialogHandlers } = require('../ipc/dialog-handlers');
const { registerFsHandlers } = require('../ipc/fs-handlers');
const { createHtmlPreviewService } = require('../electron/html-preview-service');
const { registerHtmlPreviewHandlers } = require('../ipc/html-preview-handlers');
const { createFileContextMenu } = require('../electron/file-context-menu');
const { createMoveToTrash } = require('../services/move-to-trash');
const { withHomeDir } = require('../services/home-dir');
const { defaultOnSwitch } = require('../services/ui-pref-switches');
const { registerWhisperHandlers } = require('../ipc/whisper-handlers');
const { registerVoiceHandlers } = require('../ipc/voice-handlers');
const { registerSettingsHandlers } = require('../ipc/settings-handlers');
const { registerChatHistoryHandlers } = require('../ipc/chat-history-handlers');
const { registerUpdateHandlers } = require('../ipc/update-handlers');
const { registerFeedbackHandlers } = require('../ipc/feedback-handlers');
const { registerNoticeHandlers } = require('../ipc/notice-handlers');
const { registerSkillSuggestionHandlers } = require('../ipc/skill-suggestion-handlers');
const { registerSkillMoveHandlers } = require('../ipc/skill-move-handlers');
const { registerChatConfigurationHandlers } = require('../ipc/chat-configuration-handlers');
const { registerApprovalNotificationHandlers } = require('../ipc/approval-notification-handlers');
const { createWindowPush } = require('../electron/window-push');
const { registerShellHandlers } = require('../ipc/shell-handlers');
const { registerPreviewHistoryMenuHandlers } = require('../ipc/preview-history-menu-handlers');
const { registerChatHandlers } = require('../ipc/chat-handlers');
const { registerToolPermissionHandlers } = require('../ipc/tool-permission-handlers');
const { registerRemoteHandlers } = require('../ipc/remote-handlers');
const { createCore } = require('./create-core');

/**
 * The desktop's composition (#983): Electron's objects become the core's
 * ports — `safeStorage` the secret store, `Notification` the notifications,
 * the window the event push, the native message box the user confirmation —
 * then `createCore()` builds the application, and this registers the IPC
 * handlers on it. Only the desktop's own pieces are built here: the update
 * service, the file context menu, the HTML preview.
 *
 * @param {import('./application-options').ApplicationOptions} options
 */
function createApplication({
  app,
  ipcMain,
  dialog,
  safeStorage,
  safeStorageKey = KEY_ALWAYS_DURABLE,
  fs,
  path,
  os: baseOs = nodeOs,
  crypto,
  childProcess,
  fetchImpl,
  providersModule,
  workspaceState,
  getMainWindow,
  Menu = null,
  shell = null,
  clipboard = null,
  Notification = null,
  REQ,
  PUSH,
  LIMITS,
  defaultProviderId = 'openai',
  speechProviderId = 'openai',
  updates: updatesOverride,
  systemSkillsDir = bundledSystemSkillsDir({ appPath: app.getAppPath?.(), path }),
  watchFile = null,
  realpathNative = null,
  manual = null,
  onAppLocaleChanged = null,
  onShowHiddenFilesChanged = null,
  env = process.env,
  session = null,
  WebContentsView = null,
  notices = null,
  remoteRelay = null,
}) {
  // The pushes wired here: none before the window opens or after it closes.
  const eventPush = createWindowPush(getMainWindow);
  const pushToWindow = eventPush.push;

  // Loosening only through the user-confirmation port (#980): the desktop's
  // adapter issues a receipt after the native dialog, the store redeems it.
  // Each side gets only its half of the registry. Made before the stores:
  // the preferences and the MCP servers redeem them too (#1104).
  const confirmationReceipts = createConfirmationReceipts();
  const confirmations = createNativeConfirmationAdapter({
    dialog,
    getMainWindow,
    receipts: { issue: confirmationReceipts.issue },
  });

  // One trash for the tree's Delete… and the tools' recovery copies: on macOS
  // it moves into ~/.Trash itself where the trash API refuses (#712).
  const moveToTrash = shell && typeof shell.trashItem === 'function'
    ? createMoveToTrash({ trashItem: (target) => shell.trashItem(target), homedir: () => withHomeDir(baseOs).homedir() })
    : null;

  const core = createCore({
    fs,
    path,
    os: baseOs,
    crypto,
    childProcess,
    fetchImpl,
    providersModule,
    workspaceState,
    PUSH,
    LIMITS,
    // Every store file lives here, and every secret goes through the keychain (#983).
    userDataPath: app.getPath('userData'),
    getAppVersion: () => app.getVersion?.() || '0.0.0',
    getSystemLocale: () => app.getLocale?.() || '',
    secretStore: createSafeStorageSecretStore(safeStorage),
    safeStorageKey,
    confirmationReceipts,
    confirmations,
    notifications: createSystemNotificationAdapter({ Notification, getMainWindow }),
    eventPush,
    trashItem: moveToTrash,
    // What this platform can do, resolved once at start (#1149).
    platformCapabilities: resolveRunningPlatform({ app, safeStorage, env }),
    defaultProviderId,
    speechProviderId,
    systemSkillsDir,
    watchFile,
    realpathNative,
    manual,
    onAppLocaleChanged,
    onShowHiddenFilesChanged,
    env,
    notices,
    remoteRelay,
  });
  const { getAppLocale, uiPrefsStore, chatSessionSettings } = core;
  const getActiveWorkspaceRoot = workspaceState.getActiveWorkspaceRoot;

  const updates = updatesOverride || createUpdateAdapter(createUpdateService({
    installation: app,
    storage: uiPrefsStore,
    // Nach dem Tausch laeuft schon das Helferskript und wartet auf das
    // Ende dieses Prozesses — erst danach startet es die neue Version.
    quitApp: () => app.quit(),
  }));

  registerDialogHandlers({
    ipcMain,
    dialog,
    getMainWindow,
    workspaceActivation: core.workspaceActivation,
    workspaceFolderStore: core.workspaceFolderStore,
    REQ,
    getLocale: getAppLocale,
  });
  registerApprovalNotificationHandlers({ ipcMain, approvalNotifier: core.approvalNotifier, REQ });
  // clipboard: „Informationen“ bietet den vollen Pfad zum Kopieren an (#123).
  const fileContextMenu = Menu && shell
    ? createFileContextMenu({ Menu, shell, dialog, clipboard, getLocale: getAppLocale, trashItem: moveToTrash })
    : null;
  // dialog: der Import von außen (#101) wird nativ bestätigt, nicht im Renderer.
  registerFsHandlers({
    ipcMain,
    filesystem: core.filesystem,
    REQ,
    PUSH,
    fileContextMenu,
    getMainWindow,
    dialog,
    confirmations,
    getLocale: getAppLocale,
    pdfAssets: core.pdfAssets,
    getWorkspaceRoot: getActiveWorkspaceRoot,
  });
  // The menu behind ‹ and › in the preview header (#822).
  if (Menu) registerPreviewHistoryMenuHandlers({ ipcMain, Menu, REQ, PUSH, getMainWindow });
  if (session && WebContentsView && shell) {
    const htmlPreview = createHtmlPreviewService({
      session,
      WebContentsView,
      shell,
      getMainWindow,
      getWorkspaceRoot: getActiveWorkspaceRoot,
      readWorkspaceFile: core.fsService.readWorkspaceFile,
      resolveCheckedWorkspacePath: core.filesystem.resolveCheckedWorkspacePath,
      stat: (absPath) => fs.stat(absPath),
      push: (payload) => pushToWindow(PUSH.HTML_PREVIEW_EVENT, payload),
    });
    registerHtmlPreviewHandlers({ ipcMain, htmlPreview, REQ });
  }
  registerVoiceHandlers({ ipcMain, speech: core.speech, REQ, PUSH });
  registerWhisperHandlers({ ipcMain, speech: core.speech, uiPrefsStore, REQ });
  registerSettingsHandlers({
    ipcMain,
    settings: core.settings,
    uiPrefsStore,
    workspaceFolderStore: core.workspaceFolderStore,
    providerModels: core.providerModels,
    REQ,
    workspaceActivation: core.workspaceActivation,
    getActiveWorkspaceRoot,
    presentation: core.settingsPresentation,
    toolCatalog: core.toolRegistry,
    skillCatalog: core.skillsService,
    memory: core.memory,
    webSearchSettings: core.webSearchSettings,
    imageGenerationSettings: core.imageGenerationSettings,
    mcpSettings: core.mcpSettings,
    pythonSettings: core.pythonSettings,
    shellSettings: core.shellSettings,
    confirmations,
  });
  registerModelPriceHandlers({ ipcMain, modelPrices: core.modelPrices, REQ });
  registerChatHistoryHandlers({ ipcMain, chatHistory: core.chatHistory, REQ });
  registerUpdateHandlers({ ipcMain, updates, REQ, PUSH, getMainWindow });
  registerFeedbackHandlers({ ipcMain, feedback: core.feedback, REQ });
  registerNoticeHandlers({ ipcMain, notices: core.notices, REQ, PUSH, getMainWindow, shell });
  // Ohne diese Handler bleiben der Verweis auf die Release-Seite im
  // Update-Dialog und Links in Chat-Antworten wirkungslos — das sandboxed
  // Preload kennt kein `shell`.
  if (shell) registerShellHandlers({ ipcMain, shell, clipboard, REQ });
  registerSkillSuggestionHandlers({ ipcMain, skillSuggestionService: core.skillSuggestionService, uiPrefsStore, REQ });
  registerSkillMoveHandlers({
    ipcMain,
    REQ,
    skillsService: core.skillsService,
    uiPrefsStore,
    getActiveWorkspaceRoot,
    dialog,
    confirmations,
    getMainWindow,
    getLocale: getAppLocale,
  });
  registerChatConfigurationHandlers({
    ipcMain,
    chatConfiguration: core.chatConfiguration,
    getActiveWorkspaceRoot,
    // What the chat on screen switched on a card (#774).
    getChatOverrides: () => chatSessionSettings.configOverridesFor(chatSessionSettings.getCurrentChatId()),
    REQ,
  });

  registerChatHandlers({
    ipcMain,
    chatEngine: core.chatEngine,
    conversation: core.conversation,
    REQ,
    PUSH,
    getActiveWorkspaceRoot,
    fileChangeRecorder: core.fileChangeRecorder,
  });
  registerToolPermissionHandlers({
    ipcMain,
    permissions: core.toolPermissions,
    approvals: core.approvals,
    dialog,
    getMainWindow,
    getLocale: getAppLocale,
    homeDir: core.os.homedir(),
    REQ,
    PUSH,
  });
  // Pairing a phone as the mobile remote (#1114); its Allow comes from the native dialog.
  registerRemoteHandlers({ ipcMain, pairing: core.remote.pairing, pushToWindow, REQ, PUSH });

  const runUpdateCheck = createUpdateCheck({
    updates,
    push: eventPush,
    PUSH,
    // Read when the check runs, so the switch needs no restart (#987).
    isAutomaticCheckEnabled: defaultOnSwitch(uiPrefsStore, 'autoUpdateCheckEnabled'),
    env,
  });

  return {
    runUpdateCheck,
    /** Once the window is open: an update helper waiting for this start may delete the old version (#1003). */
    confirmUpdateStarted: () => updates.confirmInstallStarted?.() ?? Promise.resolve(false),
    dispose: core.dispose,
    whenWritesSettled: core.whenWritesSettled,
    initToolRuntimes: core.initToolRuntimes,
    getValidatedLastFolder: core.getValidatedLastFolder,
    getAppLocale,
    getShowHiddenFiles: core.getShowHiddenFiles,
  };
}

module.exports = {
  createApplication,
};
