/**
 * Geteilter Renderer-State — nur Felder, die mehrere Components lesen/schreiben.
 * Component-privater State (Drag in FileTree, Aufnahme in WhisperRecorder,
 * RAF-Id in ChatStream) lebt modul-lokal im jeweiligen Component.
 */
export const appStore = {
  rootPath: null,
  activeTreeItem: null,
  selectedPath: null,
  selectedIsDirectory: false,
  llmState: {
    encryptionAvailable: true,
    activeProvider: 'openai',
    activePresetId: null,
    presets: [],
    chatTarget: null,
    providers: [],
  },
  chatMessages: [],
  chatSessionId: 0,
  chatInFlight: false,
  chatSendSeq: 0,
  chatAbortedSendSeq: 0,
  chatTokenUsage: { prompt: 0, completion: 0, total: 0 },
  currentChatId: '',
  currentChatWorkspace: null,
  lastFocusBeforeModal: null,
};
