'use strict';

/**
 * The fields a chat keeps of its own settings (#211, #725), as the history
 * stores them: normalized here once for the store and for the session
 * settings that read them back (#982).
 */

const { TOOL_PERMISSION_MODES } = require('./tool-permissions');
const { normalizeReasoningLevel } = require('./reasoning');

/** @type {readonly string[]} */
const TOOL_PERMISSION_MODE_VALUES = Object.freeze(Object.values(TOOL_PERMISSION_MODES));

/**
 * Modell und Freigabemodus eines Chats (Issue #211). Beides ist optional: Ein
 * Verlauf aus einer aelteren Version kennt die Felder nicht, und ein Chat ohne
 * eigene Wahl soll auch keine bekommen — er faellt auf den Standard zurueck.
 *
 * @param {unknown} raw
 */
function chatModelPresetIdForStore(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

/**
 * Nur die drei bekannten Modi. Ein unbekannter Wert wird verworfen statt auf
 * `smart` normalisiert: „nichts gespeichert“ und „ausdruecklich intelligent“
 * sind derselbe Lauf, aber nicht dieselbe Aussage — und ein zugespielter Wert
 * darf hier auf keinen Fall zu einer Freigabe werden.
 *
 * @param {unknown} raw
 */
function chatToolPermissionModeForStore(raw) {
  if (typeof raw !== 'string') return undefined;
  return TOOL_PERMISSION_MODE_VALUES.includes(raw) ? raw : undefined;
}

/**
 * The chat's reasoning level (#725), optional like the two above. Whether the
 * model takes it is decided when a round starts, not here.
 *
 * @param {unknown} raw
 */
function chatReasoningEffortForStore(raw) {
  return normalizeReasoningLevel(raw);
}

module.exports = {
  chatModelPresetIdForStore,
  chatToolPermissionModeForStore,
  chatReasoningEffortForStore,
};
