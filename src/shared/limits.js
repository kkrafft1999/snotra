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
});

module.exports = { LIMITS };
