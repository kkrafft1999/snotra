const { contextBridge, ipcRenderer, shell, clipboard } = require('electron');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../shared/ipc-channels');

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke(REQ.DIALOG_OPEN_FOLDER),
  readDirectory: (dirPath) => ipcRenderer.invoke(REQ.FS_READ_DIRECTORY, dirPath),
  readFile: (filePath) => ipcRenderer.invoke(REQ.FS_READ_FILE, filePath),
  moveItem: (sourcePath, destDir) => ipcRenderer.invoke(REQ.FS_MOVE_ITEM, sourcePath, destDir),
  listWorkspacePaths: () => ipcRenderer.invoke(REQ.FS_LIST_WORKSPACE_PATHS),

  // LLM provider settings (multi-provider)
  getLLMState: () => ipcRenderer.invoke(REQ.SETTINGS_GET_LLM_STATE),
  setActivePreset: (presetId) => ipcRenderer.invoke(REQ.SETTINGS_SET_ACTIVE_PRESET, presetId),
  commitSettings: (payload) => ipcRenderer.invoke(REQ.SETTINGS_COMMIT_SETTINGS, payload),
  listModels: (payload) => ipcRenderer.invoke(REQ.SETTINGS_LIST_MODELS, payload),

  getLastFolder: () => ipcRenderer.invoke(REQ.SETTINGS_GET_LAST_FOLDER),
  setLastFolder: (folderPath) => ipcRenderer.invoke(REQ.SETTINGS_SET_LAST_FOLDER, folderPath),
  getFolderHistory: () => ipcRenderer.invoke(REQ.SETTINGS_GET_FOLDER_HISTORY),
  removeFolderFromHistory: (folderPath) =>
    ipcRenderer.invoke(REQ.SETTINGS_REMOVE_FOLDER_FROM_HISTORY, folderPath),
  getUIPrefs: () => ipcRenderer.invoke(REQ.SETTINGS_GET_UI_PREFS),
  setUIPrefs: (partial) => ipcRenderer.invoke(REQ.SETTINGS_SET_UI_PREFS, partial),
  getToolCatalog: () => ipcRenderer.invoke(REQ.SETTINGS_GET_TOOL_CATALOG),
  getChatHistory: (workspaceRoot) => ipcRenderer.invoke(REQ.CHAT_HISTORY_GET, workspaceRoot ?? null),
  upsertChatSession: (session) => ipcRenderer.invoke(REQ.CHAT_HISTORY_UPSERT, session),
  deleteChatSession: (id) => ipcRenderer.invoke(REQ.CHAT_HISTORY_DELETE, id),
  setActiveChatId: (workspaceRoot, id) => ipcRenderer.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, workspaceRoot ?? null, id),
  chat: (messages, options) =>
    ipcRenderer.invoke(REQ.CHAT_SEND, {
      messages,
      workspaceRoot: options?.workspaceRoot ?? null,
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
  openExternal: (url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      /* ignore invalid URL */
    }
  },
  writeClipboardText: (text) => clipboard.writeText(String(text ?? '')),
});
