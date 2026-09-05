// WICHTIG: Das Fenster laeuft mit `sandbox: true`. Ein sandboxed Preload
// bekommt aus 'electron' nur contextBridge, crashReporter, ipcRenderer,
// nativeImage, sharedTexture, webFrame und webUtils — `shell` und `clipboard`
// gibt es hier nicht. Alles andere laeuft ueber IPC (Issue #64).
const { contextBridge, ipcRenderer } = require('electron');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../shared/ipc-channels');

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke(REQ.DIALOG_OPEN_FOLDER),
  readDirectory: (dirPath) => ipcRenderer.invoke(REQ.FS_READ_DIRECTORY, dirPath),
  readFile: (filePath) => ipcRenderer.invoke(REQ.FS_READ_FILE, filePath),
  moveItem: (sourcePath, destDir) => ipcRenderer.invoke(REQ.FS_MOVE_ITEM, sourcePath, destDir),
  listWorkspacePaths: () => ipcRenderer.invoke(REQ.FS_LIST_WORKSPACE_PATHS),
  showFileContextMenu: (filePath) => ipcRenderer.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, filePath),
  onFsItemDeleted: (callback) => {
    const channel = PUSH.FS_ITEM_DELETED;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // LLM provider settings (multi-provider)
  getLLMState: () => ipcRenderer.invoke(REQ.SETTINGS_GET_LLM_STATE),
  setActivePreset: (presetId) => ipcRenderer.invoke(REQ.SETTINGS_SET_ACTIVE_PRESET, presetId),
  commitSettings: (payload) => ipcRenderer.invoke(REQ.SETTINGS_COMMIT_SETTINGS, payload),
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
  getChatHistory: () => ipcRenderer.invoke(REQ.CHAT_HISTORY_GET),
  upsertChatSession: (session) => ipcRenderer.invoke(REQ.CHAT_HISTORY_UPSERT, session),
  generateChatTitle: (messages) => ipcRenderer.invoke(REQ.CHAT_TITLE, { messages }),
  deleteChatSession: (id) => ipcRenderer.invoke(REQ.CHAT_HISTORY_DELETE, id),
  setActiveChatId: (id) => ipcRenderer.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, id),
  chat: (messages, options) =>
    ipcRenderer.invoke(REQ.CHAT_SEND, {
      messages,
      selectedPath: options?.selectedPath ?? null,
      selectedIsDirectory: options?.selectedIsDirectory ?? false,
    }),
  abortChat: () => ipcRenderer.send(REQ.CHAT_ABORT),
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
  transcribeAudio: (audioBuffer) => ipcRenderer.invoke(REQ.WHISPER_TRANSCRIBE, audioBuffer),

  // Self-Update (Notifier)
  getAppVersion: () => ipcRenderer.invoke(REQ.UPDATE_GET_VERSION),
  checkForUpdate: () => ipcRenderer.invoke(REQ.UPDATE_CHECK),
  ignoreUpdateVersion: (version) => ipcRenderer.invoke(REQ.UPDATE_IGNORE_VERSION, version),
  onUpdateAvailable: (callback) => {
    const channel = PUSH.UPDATE_AVAILABLE;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Beides geht ueber den Main-Prozess; die Protokollpruefung sitzt dort.
  openExternal: (url) => ipcRenderer.invoke(REQ.SHELL_OPEN_EXTERNAL, url),
  writeClipboardText: (text) =>
    ipcRenderer.invoke(REQ.SHELL_WRITE_CLIPBOARD_TEXT, String(text ?? '')),
});
