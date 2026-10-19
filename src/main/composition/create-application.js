'use strict';

const nodeOs = require('os');
const nodeCrypto = require('crypto');
const nodeChildProcess = require('child_process');

const { createStorageService } = require('../services/storage-service');
const { createModelPriceService } = require('../services/model-price-service');
const { registerModelPriceHandlers } = require('../ipc/model-price-handlers');
const { createChatAttachmentStore } = require('../services/chat-attachment-store');
const { createFsService } = require('../services/fs-service');
const { createFileChangeRecorder } = require('../services/file-change-recorder');
const { createWhisperService } = require('../services/whisper-service');
const { createRealtimeTranscriptionService } = require('../services/realtime-transcription-service');
const { createUpdateService } = require('../services/update-service');
const { createSkillsService, bundledSystemSkillsDir } = require('../services/skills-service');
const { createSkillsWatcher } = require('../services/skills-watcher');
const { createWorkspaceWatcher } = require('../services/workspace-watcher');
const { createSkillSuggestionService } = require('../services/skill-suggestion-service');
const { createWorkspaceActivation } = require('../services/workspace-activation');
const { createWorkspaceSandboxDefault } = require('../services/workspace-sandbox-default');
const { createToolPolicyStore } = require('../services/tool-policy-store');
const { KEY_ALWAYS_DURABLE } = require('../services/safe-storage-key-durability');
const { createToolApprovalAdapter } = require('../adapters/tool-approval-adapter');
const { createNativeConfirmationAdapter } = require('../adapters/native-confirmation-adapter');
const { createConfigProposalAdapter } = require('../adapters/config-proposal-adapter');
const { createConfirmationReceipts } = require('../../application/permissions/user-confirmation');
const { createSessionGrants } = require('../../application/permissions/session-grants');
const { PERMISSION_DENIAL_REASONS } = require('../../shared/contracts/tool-permissions');
const { createWorkspaceTreeChangedEvent } = require('../../shared/contracts/workspace-tree');
const { TOOL_SETUPS } = require('../../shared/contracts/chat-configuration');
const { createWorkspaceToolRegistry } = require('../tools/workspace-tool-registry');
const { createManualLookup, loadVendoredMarkedLexer } = require('../services/manual-lookup');
const { createMcpService } = require('../services/mcp-service');
const { createMcpAdapter } = require('../adapters/mcp-adapter');
const { createTavilyWebSearchAdapter } = require('../adapters/tavily-web-search-adapter');
const { createImageGenerationSettings } = require('../services/image-generation-settings');
const { createHttpUrlFetchAdapter } = require('../adapters/http-url-fetch-adapter');
const { createPythonRunnerService } = require('../services/python-runner-service');
const { createShellRunnerService } = require('../services/shell-runner-service');
const { createSandboxService, sensitiveReadPaths } = require('../services/sandbox-service');
const { createOutsideAccess } = require('../services/outside-access');
const { createApprovalNotifier } = require('../services/approval-notifier');
const { createProgramAllowances } = require('../services/program-allowances-service');
const { existsSync, readFileSync } = require('fs');
const { createSettingsPresentationService } = require('../services/settings-presentation-service');
const { resolveRunningPlatform } = require('../platforms/running-platform');
const {
  createProviderRuntimeAdapter,
  createProviderCatalogAdapter,
} = require('../adapters/provider-catalog-adapter');
const { createProviderModelListingAdapter } = require('../adapters/provider-model-listing-adapter');
const {
  createLlmConfigStorePort,
  createUiPrefsStorePort,
  createChatHistoryStorePort,
  createWebSearchStorePort,
  createMcpConfigStorePort,
  createMcpSecretsPort,
  createWorkspaceFolderStorePort,
} = require('../adapters/persistence-store-adapters');
const { createOwnSecrets } = require('../services/own-secrets');
const { createMcpSettings } = require('../services/mcp-settings');
const { createSecurityPageData } = require('../services/security-page-data');
const { createProviderSecretsPort } = require('../adapters/provider-secrets-adapter');
const { createCredentialAdapter } = require('../adapters/credential-adapter');
const { createFilesystemIpcAdapter } = require('../adapters/filesystem-ipc-adapter');
const { createSpeechAdapter } = require('../adapters/speech-adapter');
const { createUpdateAdapter, createUpdateCheck } = require('../adapters/update-adapter');
const { registerDialogHandlers } = require('../ipc/dialog-handlers');
const { registerFsHandlers } = require('../ipc/fs-handlers');
const { createPdfAssetReader } = require('../services/pdf-assets');
const { createDocumentTextExtractor } = require('../services/document-text-worker');
const { createDocumentTextService } = require('../services/document-text-service');
const { createHtmlPreviewService } = require('../services/html-preview-service');
const { registerHtmlPreviewHandlers } = require('../ipc/html-preview-handlers');
const { createFileContextMenu } = require('../services/file-context-menu');
const { createMoveToTrash } = require('../services/move-to-trash');
const { withHomeDir } = require('../services/home-dir');
const { createRememberedUiPrefs } = require('../services/remembered-ui-prefs');
const { createWatcherWarning } = require('../services/watcher-warning');
const { defaultOnSwitch } = require('../services/ui-pref-switches');
const { createExecutionToolSettings, pythonCommandForSandbox } = require('../services/execution-tool-settings');
const { registerWhisperHandlers } = require('../ipc/whisper-handlers');
const { registerVoiceHandlers } = require('../ipc/voice-handlers');
const {
  registerSettingsHandlers,
  applyActivePreset,
  isPresetUsable,
} = require('../ipc/settings-handlers');
const { createChatSessionSettings } = require('../services/chat-session-settings');
const { registerChatHistoryHandlers } = require('../ipc/chat-history-handlers');
const { registerUpdateHandlers } = require('../ipc/update-handlers');
const { registerFeedbackHandlers } = require('../ipc/feedback-handlers');
const { createFeedbackService, osVersionReader, resolveFeedbackEndpoint } = require('../services/feedback-service');
const { registerNoticeHandlers } = require('../ipc/notice-handlers');
const { createAppNotices, postStoreFileEvent } = require('../services/app-notices');
const { registerSkillSuggestionHandlers } = require('../ipc/skill-suggestion-handlers');
const { registerSkillMoveHandlers } = require('../ipc/skill-move-handlers');
const { registerChatConfigurationHandlers } = require('../ipc/chat-configuration-handlers');
const { registerApprovalNotificationHandlers } = require('../ipc/approval-notification-handlers');
const { createWindowPush } = require('../ipc/window-push');
const { createChatConfigurationService } = require('../services/chat-configuration-service');
const { registerShellHandlers } = require('../ipc/shell-handlers');
const { registerPreviewHistoryMenuHandlers } = require('../ipc/preview-history-menu-handlers');
const { createChatApplication } = require('./create-chat-application');
const { startToolRuntimes } = require('./start-tool-runtimes');
const { createEnvironmentAdapter } = require('../adapters/environment-adapter');
const { createProjectInstructionsAdapter } = require('../adapters/project-instructions-adapter');
const { createMemoryAdapter } = require('../adapters/memory-adapter');
const { APP_NAME } = require('../app-identity');
const { registerChatHandlers } = require('../ipc/chat-handlers');
const { registerToolPermissionHandlers } = require('../ipc/tool-permission-handlers');
const { createRemoteBridge } = require('./create-remote-bridge');
const { registerRemoteHandlers } = require('../ipc/remote-handlers');

function createApplication({
  app,
  ipcMain,
  dialog,
  safeStorage,
  /**
   * When ciphertext may reach the disk (#1060): on a fresh Windows profile,
   * once the key behind `safeStorage` is in `Local State`. index.js hands in
   * the real one; without it nothing waits.
   */
  safeStorageKey = KEY_ALWAYS_DURABLE,
  fs,
  path,
  os: baseOs = nodeOs,
  crypto = nodeCrypto,
  childProcess = nodeChildProcess,
  fetchImpl,
  providersModule,
  workspaceState,
  getMainWindow,
  Menu = null,
  shell = null,
  clipboard = null,
  /** Electron's, for a card waiting out of sight (#792, step 5); without it, none. */
  Notification = null,
  REQ,
  PUSH,
  LIMITS,
  defaultProviderId = 'openai',
  speechProviderId = 'openai',
  updates: updatesOverride,
  /** Where the system skills are; by default next to the app (`system-skills`). */
  systemSkillsDir = bundledSystemSkillsDir({ app, path }),
  /**
   * `fs.watch` aus dem synchronen fs-Modul — `fs` ist hier fs/promises und
   * hat es nicht. Fehlt es, laeuft alles ohne Skill-Watcher (Issue #126).
   */
  watchFile = null,
  /**
   * `fs.realpathSync.native`, aus demselben Grund von aussen hereingereicht.
   * Nur der Dateibaum-Watcher braucht es — und nur, um Windows nicht an einem
   * 8.3-Kurznamen abstuerzen zu lassen (Issue #158).
   */
  realpathNative = null,
  /**
   * The bundled user manual (manual-service.js). With it the model gets
   * search_manual and read_manual_page (#947); without it, neither.
   */
  manual = null,
  /**
   * Called when the user switches the language (epic #277). The caller rebuilds
   * the menu bar from it — the menu belongs to them, not here.
   */
  onAppLocaleChanged = null,
  /**
   * Called when hidden files in the tree are switched on or off, and at
   * start-up when the stored value is on (#436). The caller ticks the checkbox
   * in its View menu, which starts unticked.
   */
  onShowHiddenFilesChanged = null,
  /**
   * The process environment. Only `SNOTRA_NO_UPDATE_CHECK` is read: set to
   * `1`, the silent check at start-up does not ask GitHub (#407). The smoke
   * test sets it, so a release published in the meantime cannot put the
   * update dialog over the window it takes screenshots of.
   */
  env = process.env,
  /**
   * Electron's `session` and `WebContentsView`, for HTML files as live pages
   * (#479). Without them the channels stay unregistered and the HTML view
   * says that the preview could not be started.
   */
  session = null,
  WebContentsView = null,
  /**
   * The notices for the window (#1001). The caller may hand in its own, so
   * that the error path it set up before the app was ready (#978) posts to
   * the same list the window reads; without one a fresh list is made here.
   */
  notices: givenNotices = null,
  /**
   * The relay of the mobile remote (#1114). Without one, the Firebase relay of
   * `src/main/remote/relay-endpoint.js`; tests hand in the in-memory relay.
   */
  remoteRelay = null,
}) {
  // Every adapter below asks this `os` for the home folder (#707).
  const os = withHomeDir(baseOs);
  const providerRuntime = createProviderRuntimeAdapter(providersModule);
  const providerCatalog = createProviderCatalogAdapter(providerRuntime);

  // Notices for the window (#1001). Created first: the stores report what
  // they set aside while they are read, before the window exists.
  const notices = givenNotices || createAppNotices();
  // The pushes wired here: none before the window opens or after it closes.
  const pushToWindow = createWindowPush(getMainWindow);

  // The receipts of the user-confirmation port (#980). Made before the
  // stores: the preferences and the MCP servers redeem them too (#1104).
  const confirmationReceipts = createConfirmationReceipts();

  const storage = createStorageService({
    app,
    safeStorage,
    safeStorageKey,
    fs,
    path,
    providerCatalog,
    maxChatSessions: LIMITS.MAX_CHAT_SESSIONS,
    maxFolderHistory: LIMITS.MAX_FOLDER_HISTORY,
    defaultProviderId,
    onStoreFileEvent: (event) => postStoreFileEvent(notices, event),
    confirmationReceipts: { redeem: confirmationReceipts.redeem },
  });

  // Prices for the estimated chat cost (#949).
  const modelPrices = createModelPriceService({ fs, path, app, providers: providersModule });

  // Bilder eines Chats liegen als Dateien neben der Verlaufsdatei, nicht als
  // Base64 darin (Issue #94).
  const chatAttachments = createChatAttachmentStore({ app, fs, path });

  const llmConfigStore = createLlmConfigStorePort(storage);
  const providerSecrets = createProviderSecretsPort(storage);
  const uiPrefsStore = createUiPrefsStorePort(storage);
  const chatHistoryStore = createChatHistoryStorePort(storage);
  const workspaceFolderStore = createWorkspaceFolderStorePort(storage);
  const webSearchStore = createWebSearchStorePort(storage);

  // The interface language (epic #277) and the hidden-files switch (#436),
  // remembered for the menus the caller builds synchronously.
  const rememberedUiPrefs = createRememberedUiPrefs({ uiPrefsStore, onAppLocaleChanged, onShowHiddenFilesChanged });
  const { getAppLocale, getShowHiddenFiles } = rememberedUiPrefs;

  // Websuche (Issue #63). Ob ein Schluessel hinterlegt ist, muss beim Bauen der
  // Tool-Liste synchron feststehen — deshalb ein gemerkter Stand, den nur der
  // Start und das Speichern in den Einstellungen fortschreiben.
  let webSearchKeyPresent = false;
  const webSearch = createTavilyWebSearchAdapter({
    readApiKey: () => webSearchStore.getWebSearchApiKey(),
    hasApiKey: () => webSearchKeyPresent,
    fetchImpl,
  });
  const webSearchSettings = {
    isConfigured: () => webSearchKeyPresent,
    async refresh() {
      webSearchKeyPresent = await webSearchStore.hasWebSearchApiKey();
      return webSearchKeyPresent;
    },
    async setApiKey(plaintext) {
      const result = await webSearchStore.setWebSearchApiKey(plaintext);
      await webSearchSettings.refresh();
      return { ...result, hasApiKey: webSearchKeyPresent };
    },
  };

  // Loosening only through the user-confirmation port (#980): the desktop's
  // adapter issues a receipt after the native dialog, the store redeems it.
  // Each side gets only its half of the registry.
  const confirmations = createNativeConfirmationAdapter({
    dialog,
    getMainWindow,
    receipts: { issue: confirmationReceipts.issue },
  });

  // Tool-Berechtigungen (Issue #66): signierter Policy-Speicher, Karten-Adapter
  // und Sitzungsfreigaben leben im Main; der Renderer stoesst nur an.
  const toolPolicyStore = createToolPolicyStore({
    app,
    safeStorage,
    safeStorageKey,
    fs,
    path,
    crypto,
    uiPrefsPath: storage.getUIPrefsPath(),
    confirmationReceipts: { redeem: confirmationReceipts.redeem },
  });
  const approvals = createToolApprovalAdapter({ randomUUID: () => crypto.randomUUID(), PUSH });
  const sessionGrants = createSessionGrants({ nextId: () => crypto.randomUUID() });

  // Modell und Freigabemodus gehoeren zum Chat (Issue #211). Gesetzt wird
  // beides weiterhin ueber die bestehenden Wege — „Auto“ also nur nach dem
  // nativen Dialog; hier wird es je Chat gemerkt und beim Wechsel hergestellt.
  const presetDeps = { llmConfigStore, providerCatalog, safeStorage };
  const chatSessionSettings = createChatSessionSettings({
    chatHistoryStore,
    applyPreset: (presetId) => applyActivePreset(presetDeps, presetId),
    getDefaultPresetId: async () => {
      const config = await llmConfigStore.readLLMConfig();
      return config.defaultPresetId || config.activePresetId || null;
    },
    isPresetUsable: (presetId) => isPresetUsable(presetDeps, presetId),
    getPresetAlias: async (presetId) => (await llmConfigStore.readLLMConfig()).presetAliases?.[presetId] || null,
    getActivePresetId: async () => (await llmConfigStore.readLLMConfig()).activePresetId || null,
    getActiveMode: async () => (await toolPolicyStore.read()).mode,
    getWorkspaceMode: () => toolPolicyStore.readWorkspaceMode(workspaceState.getActiveWorkspaceRoot()),
    // Mirrors the chat on screen into the store. Until #320 this also dropped
    // every open card and session approval — which ended a run that waited for
    // an approval in the chat just left. Now each chat keeps its own: the new
    // chat inherits nothing because approvals are bound to their chat, and
    // what the left chat no longer needs goes in `onActivated`.
    // A chat whose "Auto" the store refuses falls back to "Smart" there (#419)
    // — the store gives it "Auto" only where it was confirmed before (#980).
    applyMode: (mode, { chatId }) => toolPolicyStore.restoreMode(mode, {
      chatId,
      workspaceRoot: workspaceState.getActiveWorkspaceRoot(),
    }),
    onChatModeChanged: (chatId) => invalidateChatPermissions(chatId),
    onActivated: () => pruneChatScopedPermissions(),
  });

  // The engine is built further down; until then no chat is running.
  let runningChatIds = () => [];

  /**
   * Open cards and session approvals belong to a chat (concept §7, #320). They
   * live as long as that chat is on screen or still has a run going; a chat the
   * user has left and that is idle loses them.
   */
  function pruneChatScopedPermissions() {
    const live = new Set(runningChatIds());
    live.add(chatSessionSettings.getCurrentChatId());
    approvals.invalidateExceptChats(live, PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
    sessionGrants.retainChats(live);
  }

  /** One chat's mode changed: only its own cards and approvals go. */
  function invalidateChatPermissions(chatId) {
    approvals.invalidateChat(chatId, PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
    sessionGrants.clearChat(chatId);
  }

  // Erst weiter unten gebaut (der Dienst braucht den Skill-Service), aber
  // schon hier benannt: Der Workspace-Wechsel direkt darunter greift darauf zu.
  let skillsWatcher = null;
  // Dasselbe fuer den Dateibaum-Watcher (Issue #158).
  let workspaceWatcher = null;
  // And for the skill scans: set once the skill service exists (#578).
  let dropSkillScans = () => {};

  const noteWorkspaceOpened = createWorkspaceSandboxDefault({ toolPolicyStore, onChanged: () => notifyToolPermissionsChanged() });

  // Einziger Weg, auf dem der aktive Workspace gesetzt wird (Issue #68).
  // Ein Workspace-Wechsel verwirft offene Freigaben und Sitzungsfreigaben (Konzept §7).
  const workspaceActivation = createWorkspaceActivation({
    fs,
    path,
    workspaceFolderStore,
    setActiveWorkspaceRoot: workspaceState.setActiveWorkspaceRoot,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    onWorkspaceChanged: (root) => {
      // A run keeps working in its own folder when the user opens another
      // one (#320), and keeps its cards and approvals with it. Everything
      // else of the folder just left goes, as before (concept §7).
      pruneChatScopedPermissions();
      // The folder skills of the workspace just left are none of our
      // business any more; the watcher moves along (#126). So does the
      // tree's: it closes the old folder's watches, or a handle would stay
      // behind (#158), and drops what it had not reported yet, or a report
      // naming the old folder would still arrive (#650).
      skillsWatcher?.watchWorkspace(root);
      workspaceWatcher?.watchWorkspace(root);
      // The watcher follows only the open folder, so a cached scan of the
      // one just left would go stale unnoticed and be served again when it
      // comes back (#578). Dropped here, it is read afresh then.
      dropSkillScans();
      // A folder opened for the first time while new workspaces start
      // without the sandbox gets that setting (#1119).
      noteWorkspaceOpened(root);
    },
  });

  const credentials = createCredentialAdapter({ providerSecrets });
  const providerModels = createProviderModelListingAdapter({ providerRuntime, providerSecrets });

  // Image generation (#85) draws with the OpenAI key voice input borrows as
  // well; the image model is a preference of its own.
  const imageGenerationSettings = createImageGenerationSettings({
    readApiKey: () => credentials.getApiKey('openai'),
    readUIPrefs: () => uiPrefsStore.readUIPrefs(),
  });

  // The global skill folders stay read-only for every tool, also when the
  // open folder contains them (#548, #650): fs-service refuses the write
  // tools, the sandbox denies the commands.
  const globalSkillRoots = [path.join(os.homedir(), '.snotra', 'skills'), path.join(os.homedir(), '.agents', 'skills')];
  const fsService = createFsService({
    fs,
    path,
    maxReadFileBytes: LIMITS.MAX_READ_FILE_BYTES,
    maxWriteFileBytes: LIMITS.MAX_WRITE_FILE_BYTES,
    // The user folders skills-service scans: read-only for the write tools
    // even when the open folder contains them (#650).
    globalSkillRoots,
    // Nur für die Wege, die beim Nutzer enden — Baum, Vorschau, Drag & Drop
    // (#292). Was an das Modell zurückgeht, bleibt englisch.
    getLocale: getAppLocale,
    // A tool path like `~/notes/todo.md` (#792, step 4).
    homeDir: os.homedir(),
  });
  // What a card may open for the file tools outside the open folder (#792,
  // step 4): the lines the sandbox cards keep, by realpath as well.
  const outsideAccess = createOutsideAccess({
    path,
    homeDir: os.homedir(),
    userDataPath: app.getPath('userData'),
    globalSkillRoots,
    realPath: (p) => fsService.resolveExistingRealPath(p),
  });
  // Before and after of every write, in memory, for "Show changes" (#348).
  const fileChangeRecorder = createFileChangeRecorder({ fs, maxBytesPerFile: LIMITS.MAX_READ_FILE_BYTES });
  const filesystem = createFilesystemIpcAdapter({
    fsService,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    getLocale: getAppLocale,
  });
  // Isolation for both execution tools (#329). Detection — dependency check,
  // proxy start, self-test — runs once per app start, on the first card or
  // run, or when the settings show a switched-on tool. Nothing of it runs for
  // someone who never enables either tool.
  const sandboxService = createSandboxService({
    os,
    path,
    fs,
    existsSync,
    spawn: childProcess.spawn,
    userDataPath: app.getPath('userData'),
    protectedWritePaths: globalSkillRoots,
    readShellPath: async () => (await shellRunnerService.detect()).path || '',
    // The interpreter run_python would use decides whether pip needs its
    // certifi fallback inside the sandbox (decision 2b on #329).
    readPythonCommand: async () => pythonCommandForSandbox(pythonRunnerService),
  });
  // Program allowances (#408): a program found through the user's PATH, and
  // folders checked against Snotra's own storage and what the sandbox keeps
  // unreadable.
  const programAllowances = createProgramAllowances({
    fs,
    path,
    os,
    platform: process.platform,
    readUserPath: async () => (await shellRunnerService.detect()).path || '',
    readAllowances: (workspaceRoot) => toolPolicyStore.readProgramAllowances(workspaceRoot),
    protectedRoots: [app.getPath('userData')],
    sensitivePaths: sensitiveReadPaths({ platform: process.platform, userDataPath: app.getPath('userData') }),
  });
  const shellRunnerService = createShellRunnerService({
    spawn: childProcess.spawn,
    os,
    fs,
    path,
    sandbox: sandboxService,
  });
  // Shell execution (#102): the same two conditions as for Python, with a
  // wider reach — a command can do whatever the signed-in user can.
  const { runner: shellRunner, settings: shellSettings } = createExecutionToolSettings({
    runnerService: shellRunnerService,
    sandboxService,
    readUIPrefs: () => uiPrefsStore.readUIPrefs(),
    enabledPref: 'shellExecutionEnabled',
    setup: TOOL_SETUPS.SHELL,
    switchSetup: TOOL_SETUPS.SHELL_SWITCH,
  });

  // Python execution (#86): a found interpreter and the switch, off by default.
  const pythonRunnerService = createPythonRunnerService({
    spawn: childProcess.spawn,
    fs,
    path,
    os,
    readInterpreterOverride: async () => (await uiPrefsStore.readUIPrefs()).pythonInterpreterPath || '',
    // PATH aus dem Shell-Profil (Issue #111). `detect()` merkt sich seinen
    // Lauf, dieser Zugriff startet also keine zweite Login-Shell — auch nicht,
    // wenn beide Erkennungen nebenlaeufig angestossen werden.
    readShellPath: async () => (await shellRunnerService.detect()).path || '',
    sandbox: sandboxService,
  });
  const { runner: pythonRunner, settings: pythonSettings } = createExecutionToolSettings({
    runnerService: pythonRunnerService,
    sandboxService,
    readUIPrefs: () => uiPrefsStore.readUIPrefs(),
    enabledPref: 'pythonExecutionEnabled',
    setup: TOOL_SETUPS.PYTHON,
    switchSetup: TOOL_SETUPS.PYTHON_SWITCH,
  });

  // Der Seitenabruf braucht keinen Schluessel und keine Einrichtung; die
  // Adressregeln stecken im Adapter (Issue #95).
  const urlFetch = createHttpUrlFetchAdapter({ getLocale: getAppLocale });

  // Gedaechtnis (Issue #166). Der Adapter kennt die zwei Pfade, der Wrapper
  // die eine Regel, die nicht in den Adapter gehoert: ob Snotra ungefragt
  // merken darf. Sie haengt an einer Einstellung und wird deshalb bei jedem
  // Aufruf frisch gelesen — ein Schalter, der erst nach einem Neustart wirkt,
  // waere bei diesem Thema keiner.
  const memory = createMemoryAdapter({
    fs,
    path,
    os,
    isSelfMemoryAllowed: defaultOnSwitch(uiPrefsStore, 'memorySelfEnabled'),
    // Die Meldungen ans Modell zitieren eine Einstellungsseite; sie soll so
    // heissen, wie der Nutzer sie sieht (#294).
    getLocale: getAppLocale,
  });

  // The vendored pdf.js (#346), read by the preview and by extract_document_text (#42).
  const PDFJS_VENDOR_DIR = path.join(__dirname, '..', '..', 'renderer', 'vendor', 'pdfjs');
  // Text out of PDF and Office files (#42), in a worker. PDFs go through the
  // pdf.js the preview ships (#346); Office files need no library at all.
  const documentText = createDocumentTextService({
    fs,
    fsService,
    extractor: createDocumentTextExtractor({ pdfjsDir: PDFJS_VENDOR_DIR }),
  });
  // The model's look into the manual (#947), with the marked the help window runs.
  const MARKED_VENDOR_FILE = path.join(__dirname, '..', '..', 'renderer', 'vendor', 'marked.umd.js');
  const manualLookup = manual
    ? createManualLookup({ manual, loadLexer: () => loadVendoredMarkedLexer(MARKED_VENDOR_FILE, { readFileSync }) })
    : null;
  // Which skills and tools a chat has (#773); assigned once the skills exist.
  let chatConfiguration = null;
  const toolRegistry = createWorkspaceToolRegistry({
    fsService,
    webSearch,
    pythonRunner,
    urlFetch,
    shellRunner,
    memory,
    documentText,
    imageGeneration: imageGenerationSettings.adapter,
    // Built further down: it needs the skills and the MCP servers (#773).
    configuration: { describeForModel: (input) => chatConfiguration.describeForModel(input) },
    manual: manualLookup,
  });

  // MCP-Server (Issue #106/#107). Verbunden wird traege — `setServers` startet
  // nichts, erst der erste Lauf mit Tool-Bedarf tut es. Den PATH bekommt der
  // Dienst wie der Python-Runner aus dem Shell-Profil (Issue #111): ohne ihn
  // faende eine aus dem Finder gestartete App weder `npx` noch `uvx`.
  const mcpConfigStore = createMcpConfigStorePort(storage);
  const mcpService = createMcpService({
    spawn: childProcess.spawn,
    readShellPath: async () => (await shellRunnerService.detect()).path || '',
    clientInfo: { name: APP_NAME, version: app?.getVersion?.() || '0.0.0' },
    // Der Tool-Katalog wird mitgeschrieben, damit die Einstellungen ihn auch
    // dann zeigen, wenn der Server nicht laeuft (Issue #170).
    rememberTools: (id, names) => mcpConfigStore.updateMcpServerKnownTools(id, names),
  });
  const mcpAdapter = createMcpAdapter({ mcpService });
  const mcpSecrets = createMcpSecretsPort(storage);

  // Provider keys, gateway headers, MCP secrets and the web search key, in
  // every form they can turn up in (concept §5, #505).
  const ownSecrets = createOwnSecrets({ llmConfigStore, providerSecrets, mcpSecrets, webSearchStore });

  // What Settings › MCP reads and does, and the take-over of the saved
  // servers (#108); statuses go out masked (CR-B14-01).
  const mcpSettings = createMcpSettings({ mcpService, mcpAdapter, mcpConfigStore, mcpSecrets, ownSecrets, uiPrefsStore });

  // Folder skills come from the workspace and the home folder.
  const skillsService = createSkillsService({ fs, path, os, systemSkillsDir });

  // Aenderungen an den Skill-Verzeichnissen verwerfen den Scan-Cache und
  // melden sich beim Renderer (Issue #126) — „Skills neu laden“ bleibt als
  // Ausweg, ist aber nicht mehr noetig. Ohne watch-Implementierung (Tests)
  // laeuft alles wie vorher, nur ohne Watcher.
  dropSkillScans = () => skillsService.reload();

  chatConfiguration = createChatConfigurationService({
    skills: skillsService,
    toolRegistry,
    uiPrefsStore,
    mcpConfigStore,
  });

  // A failing watch is logged, at most one line per watcher and minute (#648).
  skillsWatcher = watchFile
    ? createSkillsWatcher({
        watch: watchFile,
        path,
        os,
        fs,
        onError: createWatcherWarning('skills-watcher'),
        onChange: () => {
          skillsService.reload();
          pushToWindow(PUSH.SKILLS_CHANGED);
        },
      })
    : null;
  // Gleich anwerfen: Die Home-Quelle gilt auch ohne geoeffneten Ordner, und
  // ein beim Start wiederhergestellter Workspace setzt den Root womoeglich,
  // bevor es den Watcher gab.
  skillsWatcher?.watchWorkspace(workspaceState.getActiveWorkspaceRoot());

  // Der Dateibaum zeigte bis Issue #158 nur den Stand vom letzten Mal, als die
  // App selbst etwas angefasst hat. Jetzt meldet der Watcher jede Aenderung im
  // Projektordner — von der KI, aus dem Terminal, aus dem Finder — und der
  // Renderer laedt die betroffenen, sichtbaren Ordner nach. Ohne
  // watch-Implementierung (Tests) laeuft alles wie vorher, nur ohne Watcher.
  workspaceWatcher = watchFile
    ? createWorkspaceWatcher({
        watch: watchFile,
        path,
        // Nur zum Beobachten: Ein 8.3-Kurzname im Pfad bringt libuv unter
        // Windows zum Abbruch des ganzen Prozesses (siehe workspace-watcher).
        realpath: realpathNative,
        fs,
        onError: createWatcherWarning('workspace-watcher'),
        onChange: ({ directories, complete }) =>
          pushToWindow(PUSH.FS_TREE_CHANGED, createWorkspaceTreeChangedEvent({ directories, complete })),
      })
    : null;
  workspaceWatcher?.watchWorkspace(workspaceState.getActiveWorkspaceRoot());

  // Live voice input (#859), and Whisper as its fallback.
  const speechLocale = async () => (await uiPrefsStore.readUIPrefs()).appLocale;
  const realtimeTranscription = createRealtimeTranscriptionService({
    credentials,
    speechProviderId,
    getAppLocale: speechLocale,
  });
  const whisperService = createWhisperService({
    fetchImpl,
    credentials,
    speechProviderId,
    getAppLocale: speechLocale,
  });
  const speech = createSpeechAdapter(realtimeTranscription, whisperService);

  const updates = updatesOverride || createUpdateAdapter(createUpdateService({
    app,
    storage: uiPrefsStore,
    // Nach dem Tausch laeuft schon das Helferskript und wartet auf das
    // Ende dieses Prozesses — erst danach startet es die neue Version.
    quitApp: () => app.quit(),
  }));

  // What this platform can do, resolved once at start (#1149).
  const platformCapabilities = resolveRunningPlatform({ app, safeStorage, env });
  const settingsPresentation = createSettingsPresentationService({ providerCatalog, defaultProviderId, platformCapabilities });

  // Umgebungsangaben fuer den Systemprompt (Issue #138). Die Shell kommt aus
  // derselben Erkennung wie `shell_execute` selbst — sonst nennt der Prompt
  // eine andere Shell, als ein Befehl spaeter startet.
  const environment = createEnvironmentAdapter({
    fs,
    path,
    os,
    appName: APP_NAME,
    getAppVersion: () => app.getVersion(),
    describeShell: () => shellSettings.describe(),
  });

  // Projektanweisungen aus AGENTS.md (Issue #212). Kein Cache, kein Watcher:
  // Die Kette ist vier Dateien lang und wird je Anfrage frisch gelesen — eine
  // geaenderte AGENTS.md wirkt damit ab der naechsten Nachricht.
  const projectInstructions = createProjectInstructionsAdapter({ fs, path, os });

  // One trash for the tree's Delete… and the tools' recovery copies: on macOS
  // it moves into ~/.Trash itself where the trash API refuses (#712).
  const moveToTrash = shell && typeof shell.trashItem === 'function'
    ? createMoveToTrash({ trashItem: (target) => shell.trashItem(target), homedir: () => os.homedir() })
    : null;

  const { engine: chatEngine, llm: chatLlm } = createChatApplication({
    llmConfigStore,
    providerRuntime,
    providerSecrets,
    uiPrefsStore,
    toolRegistry,
    skillsService,
    environment,
    projectInstructions,
    memory,
    path,
    maxToolRounds: LIMITS.MAX_TOOL_ROUNDS,
    toolPolicyStore,
    approvals,
    sessionGrants,
    // A run in the background keeps the mode of its own chat (#320).
    resolveChatMode: (chatId) => chatSessionSettings.modeFor(chatId),
    resolveReasoningLevel: (chatId) => chatSessionSettings.reasoningEffortFor(chatId),
    modelPrices,
    // A run that ended off screen takes its approvals with it.
    onRunSettled: () => pruneChatScopedPermissions(),
    // The chat's own skills and tools, and the card that changes them (#774).
    configProposals: createConfigProposalAdapter({
      chatSessionSettings,
      prepareProposal: (input) => chatConfiguration.prepareProposal(input),
    }),
    toolAdapterDeps: {
      fsService,
      fileChangeRecorder,
      fs,
      path,
      // Harte Grenze: Snotra-eigener Speicher (Konfiguration, Policy, Verlauf).
      protectedRoots: [app.getPath('userData')],
      outsideAccess,
      trashItem: moveToTrash,
      readOwnSecrets: ownSecrets.readOwnSecrets,
      // Die Freigabekarte nennt die Shell, mit der ein Befehl laufen wuerde (#102).
      describeShell: () => shellRunnerService.describe(),
      // …and whether it would run isolated, with which domains (#329). The
      // planner reads the shell right after this; waiting for its detection
      // here keeps a card shown early after startup from lacking it.
      describeSandbox: async () => {
        await shellRunnerService.detect();
        return sandboxService.detect();
      },
      // The user's per-workspace opt-out (#357), from the signed policy file.
      isSandboxDisabled: (workspaceRoot) => toolPolicyStore.isWorkspaceSandboxDisabled(workspaceRoot),
      // Program allowances (#408), from the same file.
      matchProgramAllowance: (request) => programAllowances.match(request),
      readProgramAllowances: (workspaceRoot) => toolPolicyStore.readProgramAllowances(workspaceRoot),
      maxScanBytes: LIMITS.MAX_READ_FILE_BYTES,
      // Einmal je Lauf: Tool-Katalog der MCP-Server neu einlesen (Issue #107).
      refreshDynamicTools: async () => {
        toolRegistry.setDynamicDefinitions(await mcpAdapter.buildToolDefinitions());
      },
    },
  });
  runningChatIds = () => chatEngine.runningChatIds();

  registerDialogHandlers({
    ipcMain, dialog, getMainWindow, workspaceActivation, workspaceFolderStore, REQ, getLocale: getAppLocale,
  });
  // A card waiting while Snotra is in the background or in another chat
  // (#792, step 5). The renderer knows when and writes the words; main shows
  // it, keeps the switch, and on a click brings the window and the chat up.
  const approvalNotifier = createApprovalNotifier({
    Notification,
    getMainWindow,
    isEnabled: defaultOnSwitch(uiPrefsStore, 'approvalNotificationsEnabled'),
    openChat: (chatId) => pushToWindow(PUSH.APPROVAL_NOTIFICATION_OPEN, { chatId }),
  });
  registerApprovalNotificationHandlers({ ipcMain, approvalNotifier, REQ });
  // clipboard: „Informationen“ bietet den vollen Pfad zum Kopieren an (#123).
  const fileContextMenu = Menu && shell
    ? createFileContextMenu({ Menu, shell, dialog, clipboard, getLocale: getAppLocale, trashItem: moveToTrash })
    : null;
  // dialog: der Import von außen (#101) wird nativ bestätigt, nicht im Renderer.
  // #346: pdf.js data files, next to the renderer code they belong to.
  const pdfAssets = createPdfAssetReader({
    fs,
    path,
    rootDir: PDFJS_VENDOR_DIR,
  });
  registerFsHandlers({
    ipcMain, filesystem, REQ, PUSH, fileContextMenu, getMainWindow, dialog, confirmations, getLocale: getAppLocale, pdfAssets,
    getWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
  });
  // The menu behind ‹ and › in the preview header (#822).
  if (Menu) registerPreviewHistoryMenuHandlers({ ipcMain, Menu, REQ, PUSH, getMainWindow });
  if (session && WebContentsView && shell) {
    const htmlPreview = createHtmlPreviewService({
      session,
      WebContentsView,
      shell,
      getMainWindow,
      getWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
      readWorkspaceFile: fsService.readWorkspaceFile,
      resolveCheckedWorkspacePath: filesystem.resolveCheckedWorkspacePath,
      stat: (absPath) => fs.stat(absPath),
      push: (payload) => pushToWindow(PUSH.HTML_PREVIEW_EVENT, payload),
    });
    registerHtmlPreviewHandlers({ ipcMain, htmlPreview, REQ });
  }
  registerVoiceHandlers({ ipcMain, speech, REQ, PUSH });
  registerWhisperHandlers({ ipcMain, speech, uiPrefsStore, REQ });
  registerSettingsHandlers({
    ipcMain,
    safeStorage,
    safeStorageKey,
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
    memory,
    webSearchSettings,
    imageGenerationSettings,
    onAppLocaleChanged: rememberedUiPrefs.setAppLocale,
    onShowHiddenFilesChanged: rememberedUiPrefs.setShowHiddenFiles,
    mcpSettings,
    pythonSettings,
    shellSettings,
    chatSessionSettings,
    confirmations,
  });
  registerModelPriceHandlers({ ipcMain, modelPrices, REQ });
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore,
    REQ,
    chatAttachments,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    isKnownWorkspaceRoot: (folderPath) => workspaceActivation.isKnownFolder(folderPath),
    chatSessionSettings,
    toolCategoryOf: (name) => toolRegistry.getDefinition(name)?.category || null,
  });
  registerUpdateHandlers({ ipcMain, updates, REQ, PUSH, getMainWindow });
  // The feedback form (#1045): sent from here, never from the window.
  const feedback = createFeedbackService({
    fetchImpl: fetchImpl || globalThis.fetch,
    getAppVersion: () => app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    getOsVersion: osVersionReader(process, os),
    isKnownProvider: (id) => providerCatalog.exists(id),
    endpoint: resolveFeedbackEndpoint(env),
  });
  registerFeedbackHandlers({ ipcMain, feedback, REQ });
  registerNoticeHandlers({ ipcMain, notices, REQ, PUSH, getMainWindow, shell });
  // Ohne diese Handler bleiben der Verweis auf die Release-Seite im
  // Update-Dialog und Links in Chat-Antworten wirkungslos — das sandboxed
  // Preload kennt kein `shell`.
  if (shell) registerShellHandlers({ ipcMain, shell, clipboard, REQ });
  // Skill-Vorschlag durch das Modell (Issue #125, Modus `model`).
  const skillSuggestionService = createSkillSuggestionService({
    llm: chatLlm,
    skillCatalog: skillsService,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    uiPrefsStore,
  });
  registerSkillSuggestionHandlers({ ipcMain, skillSuggestionService, uiPrefsStore, REQ });
  registerSkillMoveHandlers({
    ipcMain,
    REQ,
    skillsService,
    uiPrefsStore,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    dialog,
    confirmations,
    getMainWindow,
    getLocale: getAppLocale,
  });
  registerChatConfigurationHandlers({
    ipcMain,
    chatConfiguration,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    // What the chat on screen switched on a card (#774).
    getChatOverrides: () => chatSessionSettings.configOverridesFor(chatSessionSettings.getCurrentChatId()),
    REQ,
  });

  registerChatHandlers({
    ipcMain,
    chatEngine,
    REQ,
    PUSH,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    fileChangeRecorder,
  });
  // What Settings › Security and the mode pill read (#357, #447, #448).
  const securityPageData = createSecurityPageData({
    chatHistoryStore,
    uiPrefsStore,
    toolRegistry,
    mcpConfigStore,
    pythonRunner,
    shellRunner,
    sandboxService,
    workspaceFolderStore,
    fs,
    onSandboxDetected: notifyToolPermissionsChanged,
  });
  registerToolPermissionHandlers({
    ipcMain,
    dialog,
    confirmations,
    getMainWindow,
    toolPolicyStore,
    approvals,
    sessionGrants,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    REQ,
    PUSH,
    chatSessionSettings,
    getLocale: getAppLocale,
    describeExecutionTools: securityPageData.describeExecutionTools,
    programAllowances,
    describeChats: securityPageData.describeChats,
    describeTools: securityPageData.describeTools,
    describeWorkspaceChats: securityPageData.describeWorkspaceChats,
    listKnownWorkspaces: securityPageData.listKnownWorkspaces,
    folderExists: securityPageData.folderExists,
    platform: process.platform,
    platformCapabilities,
    homeDir: os.homedir(),
  });

  // Pairing a phone as the mobile remote (#1114). Nothing of it runs before
  // the user starts a pairing (R7); its Allow comes from the native dialog.
  const remote = createRemoteBridge({
    app,
    safeStorage,
    safeStorageKey,
    fs,
    path,
    fetchImpl,
    confirmations,
    receipts: { redeem: confirmationReceipts.redeem },
    getLocale: getAppLocale,
    relay: remoteRelay,
  });
  registerRemoteHandlers({ ipcMain, pairing: remote.pairing, pushToWindow, REQ, PUSH });

  // A card granted for the session, a chat left, a rule changed: the settings
  // list of session approvals follows at once (#447).
  sessionGrants.onChange(notifyToolPermissionsChanged);

  /** Makes the renderer read the permission state again — the mode pill (#357). */
  function notifyToolPermissionsChanged() {
    pushToWindow(PUSH.TOOL_PERMISSIONS_CHANGED);
  }

  const runUpdateCheck = createUpdateCheck({
    updates,
    getMainWindow,
    PUSH,
    // Read when the check runs, so the switch needs no restart (#987).
    isAutomaticCheckEnabled: defaultOnSwitch(uiPrefsStore, 'autoUpdateCheckEnabled'),
    env,
  });

  function dispose() {
    providerRuntime.disposeAll();
    skillsWatcher?.close();
    workspaceWatcher?.close();
    // Synchron und hart: `will-quit` wartet auf nichts, und die MCP-Prozesse
    // laufen in einer eigenen Prozessgruppe — ohne das hier ueberlebten sie
    // die App (Issue #106).
    mcpService.disposeSync();
    // The same for a command or script still running (#506): both start it
    // in a process group of their own, and the timer that would end it goes
    // with this process.
    shellRunnerService.disposeSync();
    pythonRunnerService.disposeSync();
    // A pairing still running is cancelled at the relay (#1114).
    remote.dispose();
    // The proxy servers live in this process and go with it; this only
    // tidies up what the runtime keeps on disk.
    void sandboxService.shutdown();
  }

  return {
    runUpdateCheck,
    /** Once the window is open: an update helper waiting for this start may delete the old version (#1003). */
    confirmUpdateStarted: () => updates.confirmInstallStarted?.() ?? Promise.resolve(false),
    dispose,
    /** The quit waits for this before the process ends (#679). */
    whenWritesSettled: () => storage.whenWritesSettled(),
    /** Beim Start einmal Interpreter suchen und die Einstellung uebernehmen (Issue #86). */
    initToolRuntimes: () =>
      startToolRuntimes({
        runtimes: [
          { name: 'python', start: () => pythonSettings.refresh() },
          { name: 'shell', start: () => shellSettings.refresh() },
          { name: 'web search', start: () => webSearchSettings.refresh() },
          { name: 'image generation', start: () => imageGenerationSettings.refresh() },
          // The saved MCP servers (#108), lazily: no process starts yet.
          { name: 'MCP', start: () => mcpSettings.start() },
        ],
        // Only now is it known which execution tools are there and whether
        // they run isolated; the mode pill read its state before that (#357).
        // Also after a failure: the others did start (#1002).
        onSettled: notifyToolPermissionsChanged,
      }),
    getValidatedLastFolder: () => workspaceFolderStore.getValidatedLastFolder(),
    getAppLocale,
    getShowHiddenFiles,
  };
}

module.exports = {
  createApplication,
};
