'use strict';

const nodeOs = require('os');
const nodeCrypto = require('crypto');
const nodeChildProcess = require('child_process');

const { createStorageService } = require('../services/storage-service');
const { createChatAttachmentStore } = require('../services/chat-attachment-store');
const { createFsService } = require('../services/fs-service');
const { createWhisperService } = require('../services/whisper-service');
const { createUpdateService } = require('../services/update-service');
const { createSkillsService } = require('../services/skills-service');
const { createSkillsWatcher } = require('../services/skills-watcher');
const { createWorkspaceWatcher } = require('../services/workspace-watcher');
const { createSkillSuggestionService } = require('../services/skill-suggestion-service');
const { createWorkspaceActivation } = require('../services/workspace-activation');
const { createToolPolicyStore } = require('../services/tool-policy-store');
const { createToolApprovalAdapter } = require('../adapters/tool-approval-adapter');
const { createSessionGrants } = require('../../application/permissions/session-grants');
const { PERMISSION_DENIAL_REASONS } = require('../../shared/contracts/tool-permissions');
const { createWorkspaceTreeChangedEvent } = require('../../shared/contracts/workspace-tree');
const { SKILL_SUGGESTION_MODES } = require('../../shared/contracts/enums');
const { createMessage, isMessage } = require('../../shared/contracts/message');
const { createWorkspaceToolRegistry } = require('../tools/workspace-tool-registry');
const { createMcpService } = require('../services/mcp-service');
const { createMcpAdapter } = require('../adapters/mcp-adapter');
const { createTavilyWebSearchAdapter } = require('../adapters/tavily-web-search-adapter');
const { createHttpUrlFetchAdapter } = require('../adapters/http-url-fetch-adapter');
const { createPythonRunnerService } = require('../services/python-runner-service');
const { createShellRunnerService } = require('../services/shell-runner-service');
const { createSandboxService, sensitiveReadPaths } = require('../services/sandbox-service');
const { createProgramAllowances } = require('../services/program-allowances-service');
const { existsSync } = require('fs');
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
  createWebSearchStorePort,
  createMcpConfigStorePort,
  createMcpSecretsPort,
  createWorkspaceFolderStorePort,
} = require('../adapters/persistence-store-adapters');
const { redactOwnSecrets } = require('../../shared/runtime/sensitive-content');
const { createProviderSecretsPort } = require('../adapters/provider-secrets-adapter');
const { createCredentialAdapter } = require('../adapters/credential-adapter');
const { createFilesystemIpcAdapter } = require('../adapters/filesystem-ipc-adapter');
const { createSpeechAdapter } = require('../adapters/speech-adapter');
const { createUpdateAdapter } = require('../adapters/update-adapter');
const { registerDialogHandlers } = require('../ipc/dialog-handlers');
const { registerFsHandlers } = require('../ipc/fs-handlers');
const { createFileContextMenu } = require('../services/file-context-menu');
const { DEFAULT_LOCALE, normalizeLocale } = require('../../shared/i18n');
const { registerWhisperHandlers } = require('../ipc/whisper-handlers');
const {
  registerSettingsHandlers,
  applyActivePreset,
  isPresetUsable,
} = require('../ipc/settings-handlers');
const { createChatSessionSettings } = require('../services/chat-session-settings');
const { registerChatHistoryHandlers } = require('../ipc/chat-history-handlers');
const { registerUpdateHandlers } = require('../ipc/update-handlers');
const { registerShellHandlers } = require('../ipc/shell-handlers');
const { createChatApplication } = require('./create-chat-application');
const { createEnvironmentAdapter } = require('../adapters/environment-adapter');
const { createProjectInstructionsAdapter } = require('../adapters/project-instructions-adapter');
const { createMemoryAdapter } = require('../adapters/memory-adapter');
const { APP_NAME } = require('../app-identity');
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
  childProcess = nodeChildProcess,
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
   * Called when the user switches the language (epic #277). The caller rebuilds
   * the menu bar from it — the menu belongs to them, not here.
   */
  onAppLocaleChanged = null,
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

  // Bilder eines Chats liegen als Dateien neben der Verlaufsdatei, nicht als
  // Base64 darin (Issue #94).
  const chatAttachments = createChatAttachmentStore({ app, fs, path });

  const llmConfigStore = createLlmConfigStorePort(storage);
  const providerSecrets = createProviderSecretsPort(storage);
  const uiPrefsStore = createUiPrefsStorePort(storage);
  const chatHistoryStore = createChatHistoryStorePort(storage);
  const workspaceFolderStore = createWorkspaceFolderStorePort(storage);
  const webSearchStore = createWebSearchStorePort(storage);

  // ── Interface language in the main process (epic #277) ────────────────────
  // The menu bar and the context menu are built synchronously; an `await` on
  // the preferences would mean a menu opening without labels. Hence a
  // remembered value, written forward by startup and by saving the settings —
  // the same construction as the web search key above.
  let appLocale = DEFAULT_LOCALE;
  const getAppLocale = () => appLocale;
  void uiPrefsStore.readUIPrefs()
    .then((prefs) => {
      const stored = normalizeLocale(prefs.appLocale);
      if (stored === appLocale) return;
      appLocale = stored;
      // The first menu is already in place while the file is still being read.
      // If the stored language differs, the caller rebuilds it now — long
      // before anyone opens it.
      onAppLocaleChanged?.(appLocale);
    })
    .catch(() => {});

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
    getActivePresetId: async () => (await llmConfigStore.readLLMConfig()).activePresetId || null,
    getActiveMode: async () => (await toolPolicyStore.read()).mode,
    // Mirrors the chat on screen into the store. Until #320 this also dropped
    // every open card and session approval — which ended a run that waited for
    // an approval in the chat just left. Now each chat keeps its own: the new
    // chat inherits nothing because approvals are bound to their chat, and
    // what the left chat no longer needs goes in `onActivated`.
    applyMode: async (mode) => {
      await toolPolicyStore.setMode(mode);
    },
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
        // A run keeps working in its own folder when the user opens another
        // one (#320), and keeps its cards and approvals with it. Everything
        // else of the folder just left goes, as before (concept §7).
        pruneChatScopedPermissions();
        // Die Ordner-Skills des alten Workspace gehen uns nichts mehr an;
        // der Watcher zieht mit (Issue #126). Ebenso der Dateibaum: Sonst
        // kaemen Meldungen fuer den alten Ordner an — und ein Handle bliebe
        // zurueck (Issue #158).
        skillsWatcher?.watchWorkspace(workspaceState.getActiveWorkspaceRoot());
        workspaceWatcher?.watchWorkspace(workspaceState.getActiveWorkspaceRoot());
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
    // Nur für die Wege, die beim Nutzer enden — Baum, Vorschau, Drag & Drop
    // (#292). Was an das Modell zurückgeht, bleibt englisch.
    getLocale: getAppLocale,
  });
  const filesystem = createFilesystemIpcAdapter({
    fsService,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    getLocale: getAppLocale,
  });
  // Shell-Ausfuehrung (Issue #102). Dieselben zwei Bedingungen wie bei Python —
  // gefundene Shell und ausdrueckliche Einstellung —, nur mit groesserer
  // Tragweite: ein Befehl kann alles, was der angemeldete Nutzer kann.
  let shellExecutionEnabled = false;
  // Die Erkennung laeuft unabhaengig vom Schalter: sie liest den PATH des
  // Nutzers, den auch der Python-Runner braucht (Issue #111). Der Schalter
  // steuert das Tool, nicht das Wissen ueber die Shell.
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
    readShellPath: async () => (await shellRunnerService.detect()).path || '',
    // The interpreter run_python would use decides whether pip needs its
    // certifi fallback inside the sandbox (decision 2b on #329).
    readPythonCommand: async () => {
      const python = pythonRunnerService.describe();
      return python.found ? python.command : 'python3';
    },
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
    readAllowances: () => toolPolicyStore.readProgramAllowances(),
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
  const shellRunner = {
    isAvailable: () => shellExecutionEnabled && shellRunnerService.isAvailable(),
    run: (request) => shellRunnerService.run(request),
  };
  const shellSettings = {
    describe: () => ({
      ...shellRunnerService.describe(),
      enabled: shellExecutionEnabled,
      sandbox: sandboxService.describe(),
    }),
    async refresh() {
      const prefs = await uiPrefsStore.readUIPrefs();
      shellExecutionEnabled = prefs.shellExecutionEnabled === true;
      await shellRunnerService.detect();
      if (shellExecutionEnabled) await sandboxService.detect();
      return shellSettings.describe();
    },
  };

  // Python-Ausfuehrung (Issue #86). Zwei Bedingungen muessen erfuellt sein,
  // damit das Tool ueberhaupt auftaucht: ein gefundener Interpreter und die
  // ausdrueckliche Einstellung — sie ist standardmaessig aus, weil
  // ausgefuehrter Code die Workspace-Grenze umgeht.
  let pythonExecutionEnabled = false;
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
  const pythonRunner = {
    isAvailable: () => pythonExecutionEnabled && pythonRunnerService.isAvailable(),
    run: (request) => pythonRunnerService.run(request),
  };
  const pythonSettings = {
    describe: () => ({
      ...pythonRunnerService.describe(),
      enabled: pythonExecutionEnabled,
      sandbox: sandboxService.describe(),
    }),
    async refresh() {
      const prefs = await uiPrefsStore.readUIPrefs();
      pythonExecutionEnabled = prefs.pythonExecutionEnabled === true;
      await pythonRunnerService.detect();
      if (pythonExecutionEnabled) await sandboxService.detect();
      return pythonSettings.describe();
    },
  };

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
    isSelfMemoryAllowed: async () => (await uiPrefsStore.readUIPrefs()).memorySelfEnabled !== false,
    // Die Meldungen ans Modell zitieren eine Einstellungsseite; sie soll so
    // heissen, wie der Nutzer sie sieht (#294).
    getLocale: getAppLocale,
  });

  const toolRegistry = createWorkspaceToolRegistry({
    fsService,
    webSearch,
    pythonRunner,
    urlFetch,
    shellRunner,
    memory,
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

  /**
   * Uebernimmt die gespeicherte Serverliste in den laufenden Dienst (Issue
   * #108). Entschluesselt wird genau hier und nur hier — der Rueckgabewert
   * bleibt im Main-Prozess.
   */
  async function reloadMcpServers() {
    mcpService.setServers(await mcpSecrets.getMcpServersForRuntime());
  }

  /**
   * Was die Oberflaeche ueber MCP erfaehrt. Der Status eines Servers traegt
   * seine Fehlermeldung und einen stderr-Auszug — und ein Server, der beim
   * Start stolpert, gibt gern seine Umgebung aus. Deshalb laeuft beides durch
   * die Maskierung, bevor es den Main-Prozess verlaesst (Konzept §5).
   */
  async function maskMcpStatuses(statuses) {
    const secrets = await mcpSecrets.getMcpSecretValues();
    if (secrets.length === 0) return statuses;
    // Since #338 the error can be a catalogue message; a server's text then
    // sits in its parameters, and that is where the masking has to reach.
    const mask = (value) => {
      if (typeof value === 'string') return redactOwnSecrets(value, secrets);
      if (!isMessage(value)) return value;
      const params = value.params
        ? Object.fromEntries(Object.entries(value.params).map(([name, inner]) => [name, mask(inner)]))
        : undefined;
      return createMessage(value.key, params);
    };
    return statuses.map((status) => ({
      ...status,
      error: mask(status.error),
      stderr: redactOwnSecrets(status.stderr, secrets),
    }));
  }

  const mcpSettings = {
    listServers: () => mcpConfigStore.readMcpServers(),
    // Synchron, weil die Statusanzeige nicht auf einen haengenden Server
    // warten darf; maskiert wird beim Testen und beim Katalog-Aufbau.
    describeConnections: () => mcpService.describeConnections(),
    describeSkippedTools: () => mcpAdapter.describeSkippedTools(),
    save: (input) => mcpConfigStore.saveMcpServer(input),
    remove: (id) => mcpConfigStore.deleteMcpServer(id),
    reload: reloadMcpServers,
    async test(id) {
      // Getestet wird der *gespeicherte* Server, nicht eine mitgeschickte
      // Konfiguration: sonst muesste die Oberflaeche Geheimnisse senden.
      await reloadMcpServers();
      const status = await mcpService.connect(id);
      if (!status) return { status: null, error: createMessage('settings.error.mcp.unknownServer', { id }) };
      const [masked] = await maskMcpStatuses([status]);
      const tools = (await mcpService.listTools())
        .filter((tool) => tool.serverId === id)
        .map((tool) => tool.name);
      return { status: masked, tools };
    },
  };

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

  // Aenderungen an den Skill-Verzeichnissen verwerfen den Scan-Cache und
  // melden sich beim Renderer (Issue #126) — „Skills neu laden“ bleibt als
  // Ausweg, ist aber nicht mehr noetig. Ohne watch-Implementierung (Tests)
  // laeuft alles wie vorher, nur ohne Watcher.
  skillsWatcher = watchFile
    ? createSkillsWatcher({
        watch: watchFile,
        path,
        os,
        onChange: () => {
          skillsService.reload();
          const win = getMainWindow();
          if (win && !win.isDestroyed()) win.webContents.send(PUSH.SKILLS_CHANGED, {});
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
        onChange: ({ directories, complete }) => {
          const win = getMainWindow();
          if (!win || win.isDestroyed()) return;
          win.webContents.send(
            PUSH.FS_TREE_CHANGED,
            createWorkspaceTreeChangedEvent({ directories, complete })
          );
        },
      })
    : null;
  workspaceWatcher?.watchWorkspace(workspaceState.getActiveWorkspaceRoot());

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

  const updates = updatesOverride || createUpdateAdapter(createUpdateService({
    app,
    storage: uiPrefsStore,
    // Nach dem Tausch laeuft schon das Helferskript und wartet auf das
    // Ende dieses Prozesses — erst danach startet es die neue Version.
    quitApp: () => app.quit(),
  }));

  const settingsPresentation = createSettingsPresentationService({
    providerCatalog,
    defaultProviderId,
  });

  /**
   * Werte aus „Name: Wert"-Zeilen. Geschwaerzt wird der **Wert**, nicht der
   * Header-Name: `X-Tenant` ist kein Geheimnis, sein Inhalt kann eines sein.
   * Sehr kurze Werte bleiben draussen, sonst schwaerzt ein `X-Env: dev` jedes
   * Vorkommen von „dev" in jeder Tool-Ausgabe.
   */
  function extraHeaderSecretValues(raw) {
    const out = [];
    for (const line of String(raw).split(/\r?\n/)) {
      const sep = line.indexOf(':');
      if (sep <= 0) continue;
      const value = line.slice(sep + 1).trim();
      if (value.length >= 8) out.push(value);
    }
    return out;
  }

  // Eigene Provider-Schluessel duerfen die App nie ueber ein Tool verlassen
  // (Konzept §5). Nur zum Vergleich gelesen, nie protokolliert.
  async function readOwnSecrets() {
    const config = await llmConfigStore.readLLMConfig();
    const secrets = [];
    const add = (effective) => {
      if (effective?.apiKey) secrets.push(effective.apiKey);
      // Zusatz-Header tragen bei einem Gateway das Token (Issue #193) und
      // duerfen die App so wenig verlassen wie ein API-Key.
      if (effective?.extraHeaders) secrets.push(...extraHeaderSecretValues(effective.extraHeaders));
    };
    for (const providerId of Object.keys(config?.providers || {})) {
      add(await providerSecrets.getEffectiveProviderConfig(providerId));
    }
    // Anbieter mit Verbindung je Eintrag (Issue #202) stehen nicht in
    // `providers`; ihre Schluessel haengen an den Eintraegen. Ohne diese
    // Schleife fiele genau der Gateway-Token durch die Schwaerzung.
    for (const preset of Array.isArray(config?.presets) ? config.presets : []) {
      if (!preset?.id || !preset.connection) continue;
      add(await providerSecrets.getEffectiveProviderConfig(preset.providerId, { presetId: preset.id }));
    }
    // Auch MCP-Tokens duerfen die App nicht ueber ein Tool-Ergebnis verlassen
    // (Issue #108) — ein MCP-Server koennte sie sonst selbst zurueckgeben.
    secrets.push(...(await mcpSecrets.getMcpSecretValues()));
    return secrets;
  }

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
    // A run that ended off screen takes its approvals with it.
    onRunSettled: () => pruneChatScopedPermissions(),
    toolAdapterDeps: {
      fsService,
      fs,
      path,
      // Harte Grenze: Snotra-eigener Speicher (Konfiguration, Policy, Verlauf).
      protectedRoots: [app.getPath('userData')],
      trashItem: shell && typeof shell.trashItem === 'function' ? (target) => shell.trashItem(target) : null,
      readOwnSecrets,
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
      readProgramAllowances: () => toolPolicyStore.readProgramAllowances(),
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
  // clipboard: „Informationen“ bietet den vollen Pfad zum Kopieren an (#123).
  const fileContextMenu = Menu && shell
    ? createFileContextMenu({ Menu, shell, dialog, clipboard, getLocale: getAppLocale })
    : null;
  // dialog: der Import von außen (#101) wird nativ bestätigt, nicht im Renderer.
  registerFsHandlers({
    ipcMain, filesystem, REQ, PUSH, fileContextMenu, getMainWindow, dialog, getLocale: getAppLocale,
  });
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
    memory,
    webSearchSettings,
    // A language change takes effect at once: the remembered value follows and
    // the application menu is rebuilt — Electron cannot rename an item.
    onAppLocaleChanged: (next) => {
      appLocale = normalizeLocale(next);
      onAppLocaleChanged?.(appLocale);
    },
    mcpSettings,
    pythonSettings,
    shellSettings,
    chatSessionSettings,
  });
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore,
    REQ,
    chatAttachments,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    isKnownWorkspaceRoot: (folderPath) => workspaceActivation.isKnownFolder(folderPath),
    chatSessionSettings,
  });
  registerUpdateHandlers({ ipcMain, updates, REQ, PUSH, getMainWindow });
  // Ohne diese Handler bleiben der Verweis auf die Release-Seite im
  // Update-Dialog und Links in Chat-Antworten wirkungslos — das sandboxed
  // Preload kennt kein `shell`.
  if (shell) registerShellHandlers({ ipcMain, shell, clipboard, REQ });
  // Skill-Vorschlag durch das Modell (Issue #125, Modus `model`). Laeuft neben
  // dem Chat und darf ihn nie stoeren: Jeder Fehler endet als "kein Vorschlag".
  const skillSuggestionService = createSkillSuggestionService({
    llm: chatLlm,
    skillCatalog: skillsService,
    getActiveWorkspaceRoot: workspaceState.getActiveWorkspaceRoot,
    uiPrefsStore,
  });
  ipcMain.handle(REQ.SKILLS_SUGGEST, async (_event, text) => {
    // Nur im dafuer eingeschalteten Modus ueberhaupt an den Provider gehen —
    // der Renderer koennte das Gegenteil behaupten.
    const prefs = await uiPrefsStore.readUIPrefs();
    if (prefs.skillSuggestionMode !== SKILL_SUGGESTION_MODES.MODEL) return { name: '' };
    try {
      const treffer = await skillSuggestionService.suggest(typeof text === 'string' ? text : '');
      return { name: treffer?.name || '' };
    } catch {
      return { name: '' };
    }
  });

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
    chatSessionSettings,
    getLocale: getAppLocale,
    describeExecutionTools,
    programAllowances,
    platform: process.platform,
    homeDir: os.homedir(),
  });

  /**
   * Which execution tools the model is offered, and what the sandbox can do
   * (#357). The mode pill turns red when "Auto" would run them unisolated.
   * Detection only runs when one of them is on — as for the settings — and
   * is not waited for: the self-test can take seconds, and the pill should
   * not hang on it. Once it is known, the renderer is told to read again.
   */
  async function describeExecutionTools() {
    let disabledTools = [];
    try {
      const prefs = await uiPrefsStore.readUIPrefs();
      disabledTools = Array.isArray(prefs.disabledTools) ? prefs.disabledTools : [];
    } catch {
      disabledTools = [];
    }
    const active = [];
    if (pythonRunner.isAvailable() && !disabledTools.includes('run_python')) active.push('run_python');
    if (shellRunner.isAvailable() && !disabledTools.includes('shell_execute')) active.push('shell_execute');
    const sandbox = sandboxService.describe();
    if (active.length > 0 && (sandbox.status === 'unknown' || sandbox.status === 'testing')) {
      void sandboxService.detect().then(notifyToolPermissionsChanged, () => {});
    }
    return { active, sandbox };
  }

  /** Makes the renderer read the permission state again — the mode pill (#357). */
  function notifyToolPermissionsChanged() {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
  }

  async function runUpdateCheck({ silent }) {
    const result = await updates.checkForUpdate({ respectIgnored: silent });
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (silent && !result.updateAvailable) return;
    win.webContents.send(PUSH.UPDATE_AVAILABLE, { ...result, manual: !silent });
  }

  function dispose() {
    providerRuntime.disposeAll();
    skillsWatcher?.close();
    workspaceWatcher?.close();
    // Synchron und hart: `will-quit` wartet auf nichts, und die MCP-Prozesse
    // laufen in einer eigenen Prozessgruppe — ohne das hier ueberlebten sie
    // die App (Issue #106).
    mcpService.disposeSync();
    // The proxy servers live in this process and go with it; this only
    // tidies up what the runtime keeps on disk.
    void sandboxService.shutdown();
  }

  return {
    runUpdateCheck,
    dispose,
    /** Beim Start einmal Interpreter suchen und die Einstellung uebernehmen (Issue #86). */
    initToolRuntimes: () =>
      Promise.all([
        pythonSettings.refresh(),
        shellSettings.refresh(),
        webSearchSettings.refresh(),
        // Gespeicherte MCP-Server uebernehmen (Issue #108). Startet noch
        // keinen Prozess — der Dienst verbindet traege.
        reloadMcpServers(),
      ]).then((result) => {
        // Only now is it known which execution tools are there and whether
        // they run isolated; the mode pill read its state before that (#357).
        notifyToolPermissionsChanged();
        return result;
      }),
    getValidatedLastFolder: () => workspaceFolderStore.getValidatedLastFolder(),
    getAppLocale,
  };
}

module.exports = {
  createApplication,
};
