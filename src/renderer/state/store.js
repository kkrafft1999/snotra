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
  // Whether the chat on screen has a run going — the send button turns into
  // stop. Runs of other chats do not count (#320).
  chatInFlight: false,
  // Runs by chat id (#320). A run outlives the screen: it goes on while the
  // user reads or writes in another chat, and writes its result back into its
  // own chat. Owned by ChatStream; the approval cards and the history column
  // only read it.
  chatRuns: new Map(),
  chatTokenUsage: { prompt: 0, completion: 0, total: 0 },
  // Woraus der zuletzt gesendete Prompt bestand (Issue #174). Lebt nur in
  // dieser Sitzung: Ein wiederhergestellter Chat kennt die Aufteilung seiner
  // alten Anfragen nicht mehr, die Anzeige sagt das dann auch.
  chatContextBreakdown: null,
  currentChatId: '',
  currentChatWorkspace: null,
  // Titel der geladenen Konversation. Leer bei einem neuen Chat — dann leitet
  // die Kopfzeile den Titel aus der ersten Nutzerfrage ab.
  currentChatTitle: '',
  lastFocusBeforeModal: null,
};
