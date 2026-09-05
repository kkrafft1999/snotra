'use strict';

const nodeOs = require('os');
const nodeCrypto = require('crypto');

const { createStorageService } = require('../services/storage-service');
const { createFsService } = require('../services/fs-service');
const { createWhisperService } = require('../services/whisper-service');
const { createUpdateService } = require('../services/update-service');
const { createSkillsService } = require('../services/skills-service');
const { createWorkspaceActivation } = require('../services/workspace-activation');
const { createToolPolicyStore } = require('../services/tool-policy-store');
const { createToolApprovalAdapter } = require('../adapters/tool-approval-adapter');
const { createSessionGrants } = require('../../application/permissions/session-grants');
const { PERMISSION_DENIAL_REASONS } = require('../../shared/contracts/tool-permissions');
const { createWorkspaceToolRegistry } = require('../tools/workspace-tool-registry');
const { createSettingsPresentationService } = require('../services/settings-presentation-service');
const {
  createProviderRuntimeAdapter,
  createProviderCatalogAdapter,
} = require('../adapters/provider-catalog-adapter');
const { createProviderModelListingAdapter } = require('../adapters/provider-model-listing-adapter');
const {
  createLlmConfigStorePort,
  createUiPrefsStorePort,
  createChatHistoryStorePort,
  createWorkspaceFolderStorePort,
} = require('../adapters/persistence-store-adapters');
const { createProviderSecretsPort } = require('../adapters/provider-secrets-adapter');
const { createCredentialAdapter } = require('../adapters/credential-adapter');
const { createFilesystemIpcAdapter } = require('../adapters/filesystem-ipc-adapter');
const { createSpeechAdapter } = require('../adapters/speech-adapter');
const { createUpdateAdapter } = require('../adapters/update-adapter');
const { registerDialogHandlers } = require('../ipc/dialog-handlers');
const { registerFsHandlers } = require('../ipc/fs-handlers');
const { createFileContextMenu } = require('../services/file-context-menu');
const { registerWhisperHandlers } = require('../ipc/whisper-handlers');
const { registerSettingsHandlers } = require('../ipc/settings-handlers');
const { registerChatHistoryHandlers } = require('../ipc/chat-history-handlers');
const { registerUpdateHandlers } = require('../ipc/update-handlers');
const { registerShellHandlers } = require('../ipc/shell-handlers');
const { createChatApplication } = require('./create-chat-application');
const { registerChatHandlers } = require('../ipc/chat-handlers');
const { registerToolPermissionHandlers } = require('../ipc/tool-permission-handlers');

function createApplication({
  app,
  ipcMain,
  dialog,
  safeStorage,
  fs,
  path,
  os = nodeOs,
  crypto = nodeCrypto,
  fetchImpl,
  providersModule,
  workspaceState,
  getMainWindow,
  Menu = null,
  shell = null,
  clipboard = null,
  REQ,
  PUSH,
  LIMITS,
  defaultProviderId = 'openai',
  speechProviderId = 'openai',
  updates: updatesOverride,
  systemSkillsDir,
}) {
  const providerRuntime = createProviderRuntimeAdapter(providersModule);
  const providerCatalog = createProviderCatalogAdapter(providerRuntime);

  const storage = createStorageService({
    app,
    safeStorage,
    fs,
    path,
    providerCatalog,
    maxChatSessions: LIMITS.MAX_CHAT_SESSIONS,
    maxFolderHistory: LIMITS.MAX_FOLDER_HISTORY,
    defaultProviderId,
  });

  const llmConfigStore = createLlmConfigStorePort(storage);
  const providerSecrets = createProviderSecretsPort(storage);
  const uiPrefsStore = createUiPrefsStorePort(storage);
  const chatHistoryStore = createChatHistoryStorePort(storage);
  const workspaceFolderStore = createWorkspaceFolderStorePort(storage);

  // Tool-Berechtigungen (Issue #66): signierter Policy-Speicher, Karten-Adapter
  // und Sitzungsfreigaben leben im Main; der Renderer stoesst nur an.
  const toolPolicyStore = createToolPolicyStore({
    app,
    safeStorage,
    fs,
    path,
    crypto,
    uiPrefsPath: storage.getUIPrefsPath(),
  });
  const approvals = createToolApprovalAdapter({ randomUUID: () => crypto.randomUUID(), PUSH });
  const sessionGrants = createSessionGrants({ nextId: () => crypto.randomUUID() });

  // Einziger Weg, auf dem der aktive Workspace gesetzt wird (Issue #68).
  // Ein Workspace-Wechsel verwirft offene Freigaben und Sitzungsfreigaben (Konzept §7).
  const workspaceActivation = createWorkspaceActivation({
    fs,
    path,
    workspaceFolderStore,
    setActiveWorkspaceRoot: (folderPath) => {
      const before = workspaceState.getActiveWorkspaceRoot();
      workspaceState.setActiveWorkspaceRoot(folderPath);
      if (workspaceState.getActiveWorkspaceRoot() !== before) {
        approvals.invalidateAll(PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
        sessionGrants.clear();
      }
    },
  });

  const credentials = createCredentialAdapter({ providerSecrets });
  const providerModels = createProviderModelListingAdapter({ providerRuntime, providerSecrets });

  const fsService = createFsService({
    fs,
    path,
    maxReadFileBytes: LIMITS.MAX_READ_FILE_BYTES,
    maxWriteFileBytes: LIMITS.MAX_WRITE_FILE_BYTES,
  });
  const filesystem = createFilesystemIpcAdapter({
    fsService,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
  });
  const toolRegistry = createWorkspaceToolRegistry({ fsService });

  // System-Skills liegen als Verzeichnis im App-Bundle (auch in app.asar
  // lesbar); Ordner-Skills kommen aus Workspace und Home-Verzeichnis.
  const resolvedSystemSkillsDir =
    systemSkillsDir !== undefined
      ? systemSkillsDir
      : typeof app?.getAppPath === 'function'
        ? path.join(app.getAppPath(), 'system-skills')
        : null;
  const skillsService = createSkillsService({
    fs,
    path,
    os,
    systemSkillsDir: resolvedSystemSkillsDir,
  });

  const whisperService = createWhisperService({
    fetchImpl,
    credentials,
    speechProviderId,
    getAppLocale: async () => {
      const prefs = await uiPrefsStore.readUIPrefs();
      return prefs.appLocale;
    },
  });
  const speech = createSpeechAdapter(whisperService);

  const updates = updatesOverride || createUpdateAdapter(createUpdateService({ app, storage: uiPrefsStore }));

  const settingsPresentation = createSettingsPresentationService({
    providerCatalog,
    defaultProviderId,
  });

  // Eigene Provider-Schluessel duerfen die App nie ueber ein Tool verlassen
  // (Konzept §5). Nur zum Vergleich gelesen, nie protokolliert.
  async function readOwnSecrets() {
    const config = await llmConfigStore.readLLMConfig();
    const secrets = [];
    for (const providerId of Object.keys(config?.providers || {})) {
      const effective = await providerSecrets.getEffectiveProviderConfig(providerId);
      if (effective?.apiKey) secrets.push(effective.apiKey);
    }
    return secrets;
  }

  const { engine: chatEngine } = createChatApplication({
    llmConfigStore,
    providerRuntime,
    providerSecrets,
    uiPrefsStore,
    toolRegistry,
    skillsService,
    path,
    maxToolRounds: LIMITS.MAX_TOOL_ROUNDS,
    toolPolicyStore,
    approvals,
    sessionGrants,
    toolAdapterDeps: {
      fsService,
      fs,
      path,
      // Harte Grenze: Snotra-eigener Speicher (Konfiguration, Policy, Verlauf).
      protectedRoots: [app.getPath('userData')],
      trashItem: shell && typeof shell.trashItem === 'function' ? (target) => shell.trashItem(target) : null,
      readOwnSecrets,
      maxScanBytes: LIMITS.MAX_READ_FILE_BYTES,
    },
  });

  registerDialogHandlers({ ipcMain, dialog, getMainWindow, workspaceActivation, REQ });
  const fileContextMenu = Menu && shell ? createFileContextMenu({ Menu, shell, dialog }) : null;
  registerFsHandlers({ ipcMain, filesystem, REQ, PUSH, fileContextMenu, getMainWindow });
  registerWhisperHandlers({ ipcMain, speech, uiPrefsStore, REQ });
  registerSettingsHandlers({
    ipcMain,
    safeStorage,
    llmConfigStore,
    uiPrefsStore,
    workspaceFolderStore,
    providerCatalog,
    providerModels,
    REQ,
    workspaceActivation,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    presentation: settingsPresentation,
    toolCatalog: toolRegistry,
    skillCatalog: skillsService,
  });
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore,
    REQ,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
  });
  registerUpdateHandlers({ ipcMain, updates, REQ });
  // Ohne diese Handler bleiben „Herunterladen“ im Update-Banner und Links in
  // Chat-Antworten wirkungslos — das sandboxed Preload kennt kein `shell`.
  if (shell) registerShellHandlers({ ipcMain, shell, clipboard, REQ });
  registerChatHandlers({
    ipcMain,
    chatEngine,
    REQ,
    PUSH,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
  });
  registerToolPermissionHandlers({
    ipcMain,
    dialog,
    getMainWindow,
    toolPolicyStore,
    approvals,
    sessionGrants,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    REQ,
    PUSH,
  });

  async function runUpdateCheck({ silent }) {
    const result = await updates.checkForUpdate({ respectIgnored: silent });
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (silent && !result.updateAvailable) return;
    win.webContents.send(PUSH.UPDATE_AVAILABLE, { ...result, manual: !silent });
  }

  function dispose() {
    providerRuntime.disposeAll();
  }

  return {
    runUpdateCheck,
    dispose,
    getValidatedLastFolder: () => workspaceFolderStore.getValidatedLastFolder(),
  };
}

module.exports = {
  createApplication,
};
