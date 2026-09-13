// Zentrale App-Limits (Review 2026-05-23, G3). MAX_TOOL_ROUNDS ist nur der
// Default — der effektive Wert ist über Einstellungen › Allgemein
// (ui-preferences.json, maxToolRounds) überschreibbar.
const LIMITS = Object.freeze({
  MAX_CHAT_SESSIONS: 200,
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
});

module.exports = { LIMITS };
