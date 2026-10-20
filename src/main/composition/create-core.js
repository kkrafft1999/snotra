'use strict';

const nodeOs = require('os');
const nodeCrypto = require('crypto');
const nodeChildProcess = require('child_process');

const { createStorageService } = require('../services/storage-service');
const { createModelPriceService } = require('../services/model-price-service');
const { createChatAttachmentStore } = require('../services/chat-attachment-store');
const { createFsService } = require('../services/fs-service');
const { createFileChangeRecorder } = require('../services/file-change-recorder');
const { createWhisperService } = require('../services/whisper-service');
const { createRealtimeTranscriptionService } = require('../services/realtime-transcription-service');
const { createSkillsService } = require('../services/skills-service');
const { createSkillsWatcher } = require('../services/skills-watcher');
const { createWorkspaceWatcher } = require('../services/workspace-watcher');
const { createSkillSuggestionService } = require('../../application/skills/skill-suggestion-service');
const { createWorkspaceActivation } = require('../services/workspace-activation');
const { createWorkspaceSandboxDefault } = require('../services/workspace-sandbox-default');
const { createToolPolicyStore } = require('../services/tool-policy-store');
const { KEY_ALWAYS_DURABLE } = require('../services/safe-storage-key-durability');
const { createToolApprovalAdapter } = require('../adapters/tool-approval-adapter');
const { createConfigProposalAdapter } = require('../adapters/config-proposal-adapter');
const {
  createConfirmationReceipts,
  createRefusingConfirmation,
} = require('../../application/permissions/user-confirmation');
const { createSessionGrants } = require('../../application/permissions/session-grants');
const { PERMISSION_DENIAL_REASONS } = require('../../shared/contracts/tool-permissions');
const { createWorkspaceTreeChangedEvent } = require('../../shared/contracts/workspace-tree');
const { TOOL_SETUPS } = require('../../shared/contracts/chat-configuration');
const { createWorkspaceToolRegistry } = require('../../application/tools/workspace-tool-registry');
const { createFileToolsAdapter } = require('../adapters/file-tools-adapter');
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
const { createSecurityPageData } = require('../../application/permissions/security-page-data');
const { createProviderSecretsPort } = require('../adapters/provider-secrets-adapter');
const { createCredentialAdapter } = require('../adapters/credential-adapter');
const { createFilesystemIpcAdapter } = require('../adapters/filesystem-ipc-adapter');
const { createSpeechAdapter } = require('../adapters/speech-adapter');
const { createPdfAssetReader } = require('../services/pdf-assets');
const { createDocumentTextExtractor } = require('../services/document-text-worker');
const { createDocumentTextService } = require('../services/document-text-service');
const { withHomeDir } = require('../services/home-dir');
const { createRememberedUiPrefs } = require('../services/remembered-ui-prefs');
const { createWatcherWarning } = require('../services/watcher-warning');
const { defaultOnSwitch } = require('../services/ui-pref-switches');
const { createExecutionToolSettings, pythonCommandForSandbox } = require('../services/execution-tool-settings');
const { createLlmPresets } = require('../services/llm-settings');
const { createSettingsService } = require('../services/settings-service');
const { createChatHistoryService } = require('../services/chat-history-service');
const { createToolPermissionService } = require('../services/tool-permission-service');
const { createConversationService } = require('../../application/chat/conversation-service');
const { translateMessage } = require('../../shared/i18n');
const { createChatHistoryAdapter } = require('../adapters/chat-history-adapter');
const { createChatSessionSettings } = require('../../application/chat/chat-session-settings');
const { createFeedbackService, osVersionReader, resolveFeedbackEndpoint } = require('../services/feedback-service');
const { createAppNotices, postStoreFileEvent } = require('../services/app-notices');
const { createChatConfigurationService } = require('../../application/chat/chat-configuration-service');
const { createChatApplication } = require('./create-chat-application');
const { startToolRuntimes } = require('./start-tool-runtimes');
const { createEnvironmentAdapter } = require('../adapters/environment-adapter');
const { createProjectInstructionsAdapter } = require('../adapters/project-instructions-adapter');
const { createMemoryAdapter } = require('../adapters/memory-adapter');
const { APP_NAME } = require('../app-identity');
const { createRemoteBridge } = require('./create-remote-bridge');

/**
 * The application without Electron and without IPC (#983, AR-08): every
 * service, the stores, the tools and the chat engine, built from ports and
 * plain values. It runs under plain Node; `create-application.js` wraps it
 * with the desktop's adapters and registers the IPC handlers on what it
 * returns. A second host — a CLI, a headless server — would do the same with
 * its own.
 *
 * @param {import('./core-options').CoreOptions} options
 */
function createCore({
  fs,
  path,
  os: baseOs = nodeOs,
  crypto = nodeCrypto,
  childProcess = nodeChildProcess,
  fetchImpl,
  providersModule,
  workspaceState,
  PUSH,
  LIMITS,
  userDataPath,
  getAppVersion = () => '0.0.0',
  getSystemLocale = () => '',
  secretStore,
  safeStorageKey = KEY_ALWAYS_DURABLE,
  confirmationReceipts = createConfirmationReceipts(),
  confirmations = createRefusingConfirmation(),
  notifications = null,
  eventPush = { push: () => false },
  trashItem = null,
  platformCapabilities = resolveRunningPlatform({ safeStorage: secretStore }),
  defaultProviderId = 'openai',
  speechProviderId = 'openai',
  systemSkillsDir = null,
  watchFile = null,
  realpathNative = null,
  manual = null,
  onAppLocaleChanged = null,
  onShowHiddenFilesChanged = null,
  env = process.env,
  notices: givenNotices = null,
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
  const pushToWindow = eventPush.push;

  const storage = createStorageService({
    userDataPath,
    secretStore,
    getSystemLocale,
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
  const modelPrices = createModelPriceService({ fs, path, userDataPath, providers: providersModule });

  // Bilder eines Chats liegen als Dateien neben der Verlaufsdatei, nicht als
  // Base64 darin (Issue #94).
  const chatAttachments = createChatAttachmentStore({ userDataPath, fs, path });

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
    /** @param {string} plaintext */
    async setApiKey(plaintext) {
      const result = await webSearchStore.setWebSearchApiKey(plaintext);
      await webSearchSettings.refresh();
      return { ...result, hasApiKey: webSearchKeyPresent };
    },
  };

  // Tool-Berechtigungen (Issue #66): signierter Policy-Speicher, Karten-Adapter
  // und Sitzungsfreigaben leben im Main; der Renderer stoesst nur an.
  const toolPolicyStore = createToolPolicyStore({
    userDataPath,
    secretStore,
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
  const llmPresets = createLlmPresets({ llmConfigStore, providerCatalog, secretStore });
  const chatSessionSettings = createChatSessionSettings({
    chatHistoryStore,
    applyPreset: (presetId) => llmPresets.applyActivePreset(presetId),
    getDefaultPresetId: async () => {
      const config = await llmConfigStore.readLLMConfig();
      return config.defaultPresetId || config.activePresetId || null;
    },
    isPresetUsable: (presetId) => llmPresets.isPresetUsable(presetId),
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
  /** @type {() => Iterable<string | null>} */
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

  /**
   * One chat's mode changed: only its own cards and approvals go.
   *
   * @param {string | null} chatId
   */
  function invalidateChatPermissions(chatId) {
    approvals.invalidateChat(chatId, PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
    sessionGrants.clearChat(chatId);
  }

  // Erst weiter unten gebaut (der Dienst braucht den Skill-Service), aber
  // schon hier benannt: Der Workspace-Wechsel direkt darunter greift darauf zu.
  /** @type {ReturnType<typeof createSkillsWatcher> | null} */
  let skillsWatcher = null;
  // Dasselbe fuer den Dateibaum-Watcher (Issue #158).
  /** @type {ReturnType<typeof createWorkspaceWatcher> | null} */
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
    userDataPath,
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
    userDataPath,
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
    protectedRoots: [userDataPath],
    sensitivePaths: sensitiveReadPaths({ platform: process.platform, userDataPath }),
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
  // #346: pdf.js data files, next to the renderer code they belong to.
  const pdfAssets = createPdfAssetReader({
    fs,
    path,
    rootDir: PDFJS_VENDOR_DIR,
  });
  // The model's look into the manual (#947), with the marked the help window runs.
  const MARKED_VENDOR_FILE = path.join(__dirname, '..', '..', 'renderer', 'vendor', 'marked.umd.js');
  const manualLookup = manual
    ? createManualLookup({ manual, loadLexer: () => loadVendoredMarkedLexer(MARKED_VENDOR_FILE, { readFileSync }) })
    : null;
  // Which skills and tools a chat has (#773); assigned once the skills exist.
  /** @type {ReturnType<typeof createChatConfigurationService>} */
  let chatConfiguration;
  const toolRegistry = createWorkspaceToolRegistry({
    fsService: createFileToolsAdapter(fsService),
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
    clientInfo: { name: APP_NAME, version: getAppVersion() },
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

  const settingsPresentation = createSettingsPresentationService({ providerCatalog, defaultProviderId, platformCapabilities });

  // Umgebungsangaben fuer den Systemprompt (Issue #138). Die Shell kommt aus
  // derselben Erkennung wie `shell_execute` selbst — sonst nennt der Prompt
  // eine andere Shell, als ein Befehl spaeter startet.
  const environment = createEnvironmentAdapter({
    fs,
    path,
    os,
    appName: APP_NAME,
    getAppVersion,
    describeShell: () => shellSettings.describe(),
  });

  // Projektanweisungen aus AGENTS.md (Issue #212). Kein Cache, kein Watcher:
  // Die Kette ist vier Dateien lang und wird je Anfrage frisch gelesen — eine
  // geaenderte AGENTS.md wirkt damit ab der naechsten Nachricht.
  const projectInstructions = createProjectInstructionsAdapter({ fs, path, os });

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
      protectedRoots: [userDataPath],
      outsideAccess,
      trashItem,
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

  // A card waiting while Snotra is in the background or in another chat
  // (#792, step 5). The renderer knows when and writes the words; main shows
  // it, keeps the switch, and on a click brings the window and the chat up.
  const approvalNotifier = createApprovalNotifier({
    notifications,
    isEnabled: defaultOnSwitch(uiPrefsStore, 'approvalNotificationsEnabled'),
    openChat: (chatId) => pushToWindow(PUSH.APPROVAL_NOTIFICATION_OPEN, { chatId }),
  });

  // The feedback form (#1045): sent from here, never from the window.
  const feedback = createFeedbackService({
    fetchImpl: fetchImpl || globalThis.fetch,
    getAppVersion,
    platform: process.platform,
    arch: process.arch,
    getOsVersion: osVersionReader(process, os),
    isKnownProvider: (id) => providerCatalog.exists(id),
    endpoint: resolveFeedbackEndpoint(env),
  });
  // Skill-Vorschlag durch das Modell (Issue #125, Modus `model`).
  const skillSuggestionService = createSkillSuggestionService({
    llm: chatLlm,
    skillCatalog: skillsService,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    uiPrefsStore,
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

  // What the settings, the chat history and the tool permissions decide —
  // reached through IPC by the desktop, directly by any other front end (#1006).
  const settings = createSettingsService({
    secretStore,
    safeStorageKey,
    llmConfigStore,
    uiPrefsStore,
    providerCatalog,
    presets: llmPresets,
    chatSessionSettings,
    skillCatalog: skillsService,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    imageGenerationSettings,
    pythonSettings,
    shellSettings,
    onAppLocaleChanged: rememberedUiPrefs.setAppLocale,
    onShowHiddenFilesChanged: rememberedUiPrefs.setShowHiddenFiles,
    confirmations,
  });
  const chatHistory = createChatHistoryService({
    chatHistoryStore,
    chatAttachments,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    isKnownWorkspaceRoot: (folderPath) => workspaceActivation.isKnownFolder(folderPath),
    chatSessionSettings,
    toolCategoryOf: (name) => toolRegistry.getDefinition(name)?.category || null,
  });
  // What a turn means for the stored chat: its cost, its name (#981).
  const conversation = createConversationService({
    engine: chatEngine,
    history: createChatHistoryAdapter(chatHistory),
    // An error is kept in the chat as the interface says it, like the renderer did.
    describeError: (error) => translateMessage(getAppLocale(), error),
  });
  const toolPermissions = createToolPermissionService({
    confirmations,
    toolPolicyStore,
    approvals,
    sessionGrants,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
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

  // Pairing a phone as the mobile remote (#1114), and the channel to it (#1192).
  // Nothing of it runs before the user starts a pairing or the application
  // starts it with a phone already paired (R7); its Allow comes from the
  // user-confirmation port.
  const remote = createRemoteBridge({
    userDataPath,
    secretStore,
    safeStorageKey,
    fs,
    path,
    fetchImpl,
    confirmations,
    receipts: { redeem: confirmationReceipts.redeem },
    getLocale: getAppLocale,
    getAppVersion,
    relay: remoteRelay,
  });

  // A card granted for the session, a chat left, a rule changed: the settings
  // list of session approvals follows at once (#447).
  sessionGrants.onChange(notifyToolPermissionsChanged);

  /** Makes the renderer read the permission state again — the mode pill (#357). */
  function notifyToolPermissionsChanged() {
    pushToWindow(PUSH.TOOL_PERMISSIONS_CHANGED);
  }

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
    // A pairing still running is cancelled at the relay (#1114), the
    // presence record of the channel deleted (#1192).
    remote.dispose();
    // The proxy servers live in this process and go with it; this only
    // tidies up what the runtime keeps on disk.
    void sandboxService.shutdown();
  }

  return {
    // What the IPC handlers of a front end are registered on.
    os,
    notices,
    secretStore,
    safeStorageKey,
    confirmations,
    platformCapabilities,
    storage,
    modelPrices,
    chatAttachments,
    llmConfigStore,
    uiPrefsStore,
    chatHistoryStore,
    workspaceFolderStore,
    providerCatalog,
    providerModels,
    rememberedUiPrefs,
    getAppLocale,
    getShowHiddenFiles,
    webSearchSettings,
    imageGenerationSettings,
    toolPolicyStore,
    approvals,
    sessionGrants,
    chatSessionSettings,
    workspaceActivation,
    fsService,
    filesystem,
    fileChangeRecorder,
    pdfAssets,
    programAllowances,
    pythonSettings,
    shellSettings,
    memory,
    toolRegistry,
    mcpSettings,
    skillsService,
    chatConfiguration,
    speech,
    settingsPresentation,
    chatEngine,
    approvalNotifier,
    feedback,
    skillSuggestionService,
    securityPageData,
    settings,
    chatHistory,
    conversation,
    toolPermissions,
    remote,
    notifyToolPermissionsChanged,
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
  };
}

module.exports = {
  createCore,
};
