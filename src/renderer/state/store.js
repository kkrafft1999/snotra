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
  // Hidden files in the tree (#436). Owned by FileTree; the `@` menu reads it,
  // so what the tree shows can be referenced.
  showHiddenFiles: false,
  llmState: {
    // The platform capability register (#1149); null until main has answered,
    // which counts as "no gap" — the guards in main decide anyway (#1156).
    platformCapabilities: null,
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
  // Estimated cost of the chat on screen, summed over all its turns (#949);
  // null until a round was spent. Saved with the chat history.
  chatCost: null,
  currentChatId: '',
  currentChatWorkspace: null,
  // Titel der geladenen Konversation. Leer bei einem neuen Chat — dann leitet
  // die Kopfzeile den Titel aus der ersten Nutzerfrage ab.
  currentChatTitle: '',
  lastFocusBeforeModal: null,
};
