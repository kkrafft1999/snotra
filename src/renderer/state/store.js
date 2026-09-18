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
