// Zentrale App-Limits (Review 2026-05-23, G3). MAX_TOOL_ROUNDS ist nur der
// Default — der effektive Wert ist über Einstellungen › Allgemein
// (ui-preferences.json, maxToolRounds) überschreibbar.
const LIMITS = Object.freeze({
  // The chat history is the agent's episodic memory (#1320, decision 8 of
  // docs/concepts/memory-and-rules-concept.md), so the limit is per folder:
  // a busy week elsewhere no longer pushes this folder's chats out. 200 is
  // what the whole history held before, so a user who works in one folder
  // keeps exactly as much as before. Chats marked *Keep* do not count.
  MAX_CHAT_SESSIONS_PER_FOLDER: 200,
  // The ceiling across all folders: the folder history remembers ten folders,
  // ten times a full folder. It is a safeguard for the index held in memory
  // and is never applied by dropping chats — the list reports when it is
  // reached, and the user decides what goes.
  MAX_CHAT_SESSIONS: 2000,
  MAX_FOLDER_HISTORY: 10,
  MAX_TOOL_ROUNDS: 14,
  MAX_READ_FILE_BYTES: 2 * 1024 * 1024,
  MAX_WRITE_FILE_BYTES: 2 * 1024 * 1024,
  // Bild-Anhaenge im Chat (Issue #84). Die Kantenlaenge ist die von den
  // Anbietern empfohlene Obergrenze: groessere Bilder werden serverseitig
  // ohnehin herunterskaliert, kosten unterwegs aber Bandbreite und Tokens.
  MAX_IMAGE_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  MAX_IMAGES_PER_MESSAGE: 4,
  MAX_IMAGE_EDGE_PX: 1568,
  // Import per Drag & Drop von außen (Issue #101). Wie bei den Verzeichnis-
  // grenzen aus #76 gilt: Überschreitung lehnt den **ganzen** Drop ab, statt
  // halb zu kopieren.
  MAX_IMPORT_ENTRIES: 2000,
  MAX_IMPORT_TOTAL_BYTES: 200 * 1024 * 1024,
  // Ab hier wird nativ bestätigt. Eine einzelne kleine Datei geht ohne
  // Rückfrage durch; Ordner werden immer bestätigt (siehe fs-handlers).
  IMPORT_CONFIRM_MIN_ENTRIES: 20,
  IMPORT_CONFIRM_MIN_BYTES: 10 * 1024 * 1024,
  // Folders one watched target may hold a watch on, where the platform is
  // watched folder by folder (Linux, #648). The kernel's watch budget is per
  // user and shared with the user's IDE and every other watcher; on older
  // kernels it is 8,192. A project outside `node_modules/` rarely has more
  // than a few hundred folders, a home folder opened as a workspace has far
  // more — there the cap is reached, said so, and the tree reloads coarsely.
  MAX_WATCHED_DIRECTORIES: 2000,
});

module.exports = { LIMITS };
