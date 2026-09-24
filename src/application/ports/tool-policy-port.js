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
 * @property {string} [rulesVersion]  changes with the rules, the sensitive
 *   paths and the integrity state — but not with the mode. Session approvals
 *   are bound to it, next to the mode, so that another chat taking the screen
 *   does not void the approvals of a run in the background (#320).
 * @property {'ok'|'unsigned'|'invalid'|'missing'} [integrity]
 * @property {boolean} [encryptionAvailable]
 */

/**
 * @typedef {Object} ToolPolicyPort
 * @property {(options?: { chatId?: string|null }) => Promise<ToolPolicySnapshot>} read
 *   `chatId` names the chat the run belongs to; `mode` is then that chat's mode,
 *   not necessarily the one of the chat on screen (#320).
 */

module.exports = {};
