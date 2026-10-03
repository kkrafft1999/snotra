// WICHTIG: Das Fenster laeuft mit `sandbox: true`. Ein sandboxed Preload
// bekommt aus 'electron' nur contextBridge, crashReporter, ipcRenderer,
// nativeImage, sharedTexture, webFrame und webUtils — `shell` und `clipboard`
// gibt es hier nicht. Alles andere laeuft ueber IPC (Issue #64).
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../shared/ipc-channels');

// Drag & Drop von aussen (Issue #101). In Electron 44 gibt es File.path
// nicht mehr; webUtils.getPathForFile ist der dokumentierte Ersatz und einer
// der wenigen Bausteine, die ein sandboxed Preload bekommt.
//
// The sources of an import are the dropped File objects and nothing else
// (#646): the preload resolves each path itself, so page script cannot name
// one — a compromised page would otherwise copy `~/.git-credentials` in
// without a dialog. A string or any other non-File makes getPathForFile
// throw, a File made by the page (or dragged out of a browser) has no path;
// both are dropped here.
function droppedFilePaths(files) {
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch {
        return '';
      }
    })
    .filter((filePath) => typeof filePath === 'string' && filePath);
}

// A drop with nothing from the file system in it does not reach main at all;
// the answer is the one main gives for an empty drop.
function invokeImport(channel, files, destDir) {
  const sources = droppedFilePaths(files);
  if (sources.length === 0) return Promise.resolve({ ok: true, copied: [], dirs: 0, files: 0, bytes: 0 });
  return ipcRenderer.invoke(channel, sources, destDir);
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke(REQ.DIALOG_OPEN_FOLDER),
  // `showHidden` lists dot files as well (#436); only the flag crosses over.
  readDirectory: (dirPath, options) =>
    ipcRenderer.invoke(REQ.FS_READ_DIRECTORY, dirPath, { showHidden: options?.showHidden === true }),
  readFile: (filePath) => ipcRenderer.invoke(REQ.FS_READ_FILE, filePath),
  // Bild aus dem Arbeitsordner fuer eine Chat-Antwort (Issue #244).
  readWorkspaceImage: (imagePath) => ipcRenderer.invoke(REQ.FS_READ_WORKSPACE_IMAGE, imagePath),
  // PDF in the file preview (#346): the file's bytes, and the data pdf.js asks for.
  readWorkspacePdf: (pdfPath) => ipcRenderer.invoke(REQ.FS_READ_WORKSPACE_PDF, pdfPath),
  readPdfAsset: (kind, filename) => ipcRenderer.invoke(REQ.PDF_READ_ASSET, kind, filename),
  moveItem: (sourcePath, destDir) => ipcRenderer.invoke(REQ.FS_MOVE_ITEM, sourcePath, destDir),
  // Both take the dropped File objects, not paths (#646).
  inspectImport: (files, destDir) => invokeImport(REQ.FS_INSPECT_IMPORT, files, destDir),
  importItems: (files, destDir) => invokeImport(REQ.FS_IMPORT_ITEMS, files, destDir),
  listWorkspacePaths: (options) =>
    ipcRenderer.invoke(REQ.FS_LIST_WORKSPACE_PATHS, { showHidden: options?.showHidden === true }),
  // Only the path: whether it is a folder main looks up itself (#649). The
  // options say whether the row carries an agent mark (#347), whether the
  // agent changed the file in the conversation on screen (#348) and, from the
  // keyboard, where the menu opens (#74); main checks the numbers.
  showFileContextMenu: (filePath, options) =>
    ipcRenderer.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, filePath, {
      agentMark: options?.agentMark === true,
      changes: options?.changes === true,
      ...(options?.position
        ? { position: { x: options.position.x, y: options.position.y } }
        : {}),
    }),
  onFsShowChanges: (callback) => {
    const channel = PUSH.FS_SHOW_CHANGES;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onFsClearAgentMark: (callback) => {
    const channel = PUSH.FS_CLEAR_AGENT_MARK;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onFsItemDeleted: (callback) => {
    const channel = PUSH.FS_ITEM_DELETED;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Der Projektordner hat sich geaendert (Issue #158) — egal durch wen.
  onFsTreeChanged: (callback) => {
    const channel = PUSH.FS_TREE_CHANGED;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // LLM provider settings (multi-provider)
  getLLMState: () => ipcRenderer.invoke(REQ.SETTINGS_GET_LLM_STATE),
  setActivePreset: (presetId) => ipcRenderer.invoke(REQ.SETTINGS_SET_ACTIVE_PRESET, presetId),
  commitSettings: (payload) => ipcRenderer.invoke(REQ.SETTINGS_COMMIT_SETTINGS, payload),
  cancelModelListing: () => ipcRenderer.invoke(REQ.SETTINGS_CANCEL_MODELS),
  listModels: (payload) => ipcRenderer.invoke(REQ.SETTINGS_LIST_MODELS, payload),

  getLastFolder: () => ipcRenderer.invoke(REQ.SETTINGS_GET_LAST_FOLDER),
  // Aktiviert einen bereits bekannten Ordner. Der Main-Prozess prueft gegen
  // den gespeicherten Verlauf; neue Ordner kommen nur ueber openFolder()
  // herein (Issue #68).
  activateFolder: (folderPath) => ipcRenderer.invoke(REQ.SETTINGS_ACTIVATE_FOLDER, folderPath),
  getFolderHistory: () => ipcRenderer.invoke(REQ.SETTINGS_GET_FOLDER_HISTORY),
  removeFolderFromHistory: (folderPath) =>
    ipcRenderer.invoke(REQ.SETTINGS_REMOVE_FOLDER_FROM_HISTORY, folderPath),
  getUIPrefs: () => ipcRenderer.invoke(REQ.SETTINGS_GET_UI_PREFS),
  setUIPrefs: (partial) => ipcRenderer.invoke(REQ.SETTINGS_SET_UI_PREFS, partial),
  getToolCatalog: () => ipcRenderer.invoke(REQ.SETTINGS_GET_TOOL_CATALOG),
  // Skill-Katalog und Chat-Verlauf haengen am aktiven Workspace. Den kennt
  // der Main-Prozess selbst — er wird hier bewusst nicht mitgeschickt (#68).
  getSkillCatalog: () => ipcRenderer.invoke(REQ.SETTINGS_GET_SKILL_CATALOG),
  reloadSkills: () => ipcRenderer.invoke(REQ.SETTINGS_RELOAD_SKILLS),
  suggestSkills: (text) => ipcRenderer.invoke(REQ.SKILLS_SUGGEST, text),
  // Gedaechtnis (Issue #166). Wie beim Skill-Katalog kennt der Main den
  // aktiven Ordner selbst — der Renderer schickt ihn bewusst nicht mit.
  getMemory: () => ipcRenderer.invoke(REQ.SETTINGS_GET_MEMORY),
  forgetMemoryEntry: (scope, line, text) => ipcRenderer.invoke(REQ.SETTINGS_FORGET_MEMORY, { scope, line, text }),
  onSkillsChanged: (callback) => {
    const channel = PUSH.SKILLS_CHANGED;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  getChatHistory: () => ipcRenderer.invoke(REQ.CHAT_HISTORY_GET),
  upsertChatSession: (session) => ipcRenderer.invoke(REQ.CHAT_HISTORY_UPSERT, session),
  generateChatTitle: (messages) => ipcRenderer.invoke(REQ.CHAT_TITLE, { messages }),
  // The diff of one or more changes to a file, by the ids of their summaries (#348).
  getFileChanges: (ids) => ipcRenderer.invoke(REQ.CHAT_FILE_CHANGES, { ids: Array.isArray(ids) ? ids : [] }),
  deleteChatSession: (id) => ipcRenderer.invoke(REQ.CHAT_HISTORY_DELETE, id),
  // Bild eines gespeicherten Anhangs nachladen (Issue #94).
  readChatAttachment: (chatId, file) => ipcRenderer.invoke(REQ.CHAT_ATTACHMENT_READ, chatId, file),
  setActiveChatId: (id) => ipcRenderer.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, id),
  // Modell und Freigabemodus des Chats herstellen (Issue #211). `activation`
  // trennt den ausdruecklichen Wechsel im Verlauf vom automatischen
  // Wiederherstellen beim Start oder Ordnerwechsel.
  activateChatSession: (id, activation) =>
    ipcRenderer.invoke(REQ.CHAT_HISTORY_ACTIVATE, id, activation),
  chat: (messages, options) =>
    ipcRenderer.invoke(REQ.CHAT_SEND, {
      messages,
      selectedPath: options?.selectedPath ?? null,
      selectedIsDirectory: options?.selectedIsDirectory ?? false,
      chatId: typeof options?.chatId === 'string' ? options.chatId : null,
      // Comes back on every event of this turn, so that a late event of an
      // earlier turn cannot land in the next one (#320).
      runId: typeof options?.runId === 'string' ? options.runId : null,
    }),
  // Stops the run of this chat only; the other chats keep theirs (#320).
  abortChat: (chatId) =>
    ipcRenderer.send(REQ.CHAT_ABORT, { chatId: typeof chatId === 'string' ? chatId : null }),
  onChatDelta: (callback) => {
    const channel = PUSH.CHAT_DELTA;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onChatToolLine: (callback) => {
    const channel = PUSH.CHAT_TOOL_LINE;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onChatProgress: (callback) => {
    const channel = PUSH.CHAT_PROGRESS;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  cancelTranscription: () => ipcRenderer.invoke(REQ.WHISPER_CANCEL),
  transcribeAudio: (audioBuffer) => ipcRenderer.invoke(REQ.WHISPER_TRANSCRIBE, audioBuffer),

  // Selbst-Update (Issue #232). Der Renderer nennt nie eine Adresse — er
  // stoesst nur an; was geladen wird, entscheidet der Main-Prozess.
  getAppVersion: () => ipcRenderer.invoke(REQ.UPDATE_GET_VERSION),
  checkForUpdate: () => ipcRenderer.invoke(REQ.UPDATE_CHECK),
  ignoreUpdateVersion: (version) => ipcRenderer.invoke(REQ.UPDATE_IGNORE_VERSION, version),
  downloadUpdate: () => ipcRenderer.invoke(REQ.UPDATE_DOWNLOAD),
  cancelUpdateDownload: () => ipcRenderer.invoke(REQ.UPDATE_CANCEL_DOWNLOAD),
  discardUpdateDownload: () => ipcRenderer.invoke(REQ.UPDATE_DISCARD_DOWNLOAD),
  installUpdate: () => ipcRenderer.invoke(REQ.UPDATE_INSTALL),
  onUpdateAvailable: (callback) => {
    const channel = PUSH.UPDATE_AVAILABLE;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onUpdateProgress: (callback) => {
    const channel = PUSH.UPDATE_PROGRESS;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Seitenleiste umschalten (Issue #167). Das Kuerzel Cmd/Ctrl+B haengt am
  // Menueeintrag im Main-Prozess — der Renderer bekommt nur das Signal, den
  // Zustand haelt er selbst.
  onToggleSidebar: (callback) => {
    const channel = PUSH.UI_TOGGLE_SIDEBAR;
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Hidden files in the tree (#436): menu "View" or Cmd+Shift+. / Ctrl+Shift+.
  // Like the sidebar, the renderer holds the state and only gets the signal.
  onToggleHiddenFiles: (callback) => {
    const channel = PUSH.UI_TOGGLE_HIDDEN_FILES;
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Markdown preview or source (#344): menu "View" or Cmd/Ctrl+Shift+M. The
  // renderer knows which file is on show and whether it is Markdown.
  onToggleMarkdownSource: (callback) => {
    const channel = PUSH.UI_TOGGLE_MARKDOWN_SOURCE;
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // New chat (issue #381): menu "File > New Chat" or Cmd/Ctrl+N. As with the
  // sidebar, the shortcut hangs on the menu item; the renderer only gets the
  // signal.
  onNewChat: (callback) => {
    const channel = PUSH.UI_NEW_CHAT;
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Einstellungen oeffnen (Menueeintrag "Einstellungen…" bzw. Cmd/Ctrl+Komma).
  // Wie oben: Das Kuerzel haengt am Menueeintrag, der Renderer bekommt nur das
  // Signal.
  onOpenSettings: (callback) => {
    const channel = PUSH.UI_OPEN_SETTINGS;
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Tool-Berechtigungen (Issue #66). Der Renderer liest den Stand, stoesst
  // Aenderungen an und beantwortet Freigabe-Karten; die Entscheidung selbst
  // trifft der Main-Prozess (Policy, native Bestaetigung fuer Auto/Allow/Deny-Loeschen).
  // Websuche (Issue #63): nur Ja/Nein-Auskunft und Setzen; der Schluessel
  // selbst kommt nie in den Renderer zurueck.
  getWebSearchState: () => ipcRenderer.invoke(REQ.SETTINGS_GET_WEB_SEARCH_STATE),
  setWebSearchApiKey: (apiKey) =>
    ipcRenderer.invoke(REQ.SETTINGS_SET_WEB_SEARCH_API_KEY, String(apiKey ?? '')),
  // MCP-Server (Issue #108). Der Katalog ist bereits maskiert — ein als geheim
  // abgelegter env-Wert kommt nur als „vorhanden" zurueck, nie als Wert. Beim
  // Speichern schickt die Oberflaeche fuer unveraenderte Geheimnisse
  // `{ keep: true }` statt eines Wertes, den sie ohnehin nicht kennt.
  getMcpCatalog: () => ipcRenderer.invoke(REQ.SETTINGS_GET_MCP_CATALOG),
  saveMcpServer: (server) => ipcRenderer.invoke(REQ.SETTINGS_SAVE_MCP_SERVER, server),
  deleteMcpServer: (id) => ipcRenderer.invoke(REQ.SETTINGS_DELETE_MCP_SERVER, String(id ?? '')),
  reloadMcpServers: () => ipcRenderer.invoke(REQ.SETTINGS_RELOAD_MCP_SERVERS),
  testMcpServer: (id) => ipcRenderer.invoke(REQ.SETTINGS_TEST_MCP_SERVER, String(id ?? '')),
  getPythonState: () => ipcRenderer.invoke(REQ.SETTINGS_GET_PYTHON_STATE),
  getShellState: () => ipcRenderer.invoke(REQ.SETTINGS_GET_SHELL_STATE),
  getToolPermissionState: () => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_GET_STATE),
  getSecurityOverview: () => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_GET_SECURITY_OVERVIEW),
  setToolPermissionMode: (mode) => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_SET_MODE, mode),
  addToolPermissionRule: (rule) => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_ADD_RULE, rule),
  removeToolPermissionRule: (ruleId) => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_REMOVE_RULE, ruleId),
  setSensitivePathPatterns: (patterns) =>
    ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, patterns),
  clearToolSessionGrants: () => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_CLEAR_SESSION_GRANTS),
  revokeToolSessionGrant: (grantId) => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_REVOKE_SESSION_GRANT, grantId),
  resetWorkspaceToolRules: () => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES),
  resetAllToolPermissions: () => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_RESET_ALL),
  setWorkspaceSandbox: (enabled) => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, enabled),
  setWorkspaceMode: (mode) => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, mode),
  setProgramAllowance: (payload) => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, payload),
  removeProgramAllowance: (programPath) =>
    ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_REMOVE_PROGRAM_ALLOWANCE, String(programPath ?? '')),
  resolveAllowanceProgram: (text) => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_RESOLVE_PROGRAM, String(text ?? '')),
  chooseAllowanceFolder: () => ipcRenderer.invoke(REQ.TOOL_PERMISSIONS_CHOOSE_ALLOWANCE_FOLDER),
  onToolPermissionsChanged: (callback) => {
    const channel = PUSH.TOOL_PERMISSIONS_CHANGED;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Freigabe-Karten: erst nach subscribeToolApprovals() schickt der Main
  // Anfragen; ohne Anmeldung werden Rueckfragen sicher abgelehnt.
  subscribeToolApprovals: () => ipcRenderer.invoke(REQ.TOOL_APPROVAL_SUBSCRIBE),
  respondToolApproval: (requestId, response) =>
    ipcRenderer.invoke(REQ.TOOL_APPROVAL_RESPOND, { requestId, response }),
  listPendingToolApprovals: () => ipcRenderer.invoke(REQ.TOOL_APPROVAL_LIST_PENDING),
  onToolApprovalRequest: (callback) => {
    const channel = PUSH.TOOL_APPROVAL_REQUEST;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onToolApprovalResolved: (callback) => {
    const channel = PUSH.TOOL_APPROVAL_RESOLVED;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Beides geht ueber den Main-Prozess; die Protokollpruefung sitzt dort.
  openExternal: (url) => ipcRenderer.invoke(REQ.SHELL_OPEN_EXTERNAL, url),
  writeClipboardText: (text) =>
    ipcRenderer.invoke(REQ.SHELL_WRITE_CLIPBOARD_TEXT, String(text ?? '')),
});
