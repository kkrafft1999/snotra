/**
 * ToolPolicy-Port (Issue #66, Konzept §7): liefert dem Core den aktuellen
 * Berechtigungsstand — Modus, Regeln, sensible Pfadmuster und eine
 * Versionskennung, an die Freigaben gebunden werden.
 *
 * Woher der Stand kommt (signierte Policy-Datei, Fail-safe bei
 * Manipulation) ist Sache des Adapters im Main-Prozess.
 */

/**
 * @typedef {Object} ToolPolicySnapshot
 * @property {'smart'|'ask-all'|'auto'} mode
 * @property {Array<object>} rules  normalisierte Regeln aller Geltungsbereiche
 * @property {string[]} sensitivePathPatterns
 * @property {string} policyVersion  ändert sich bei jeder Regel-/Modusänderung
 * @property {'ok'|'unsigned'|'invalid'|'missing'} [integrity]
 * @property {boolean} [encryptionAvailable]
 */

/**
 * @typedef {Object} ToolPolicyPort
 * @property {() => Promise<ToolPolicySnapshot>} read
 */

module.exports = {};
