/**
 * ChatPreferences-Port: schmale UI-Prefs-Schnittstelle für den Chat-Core.
 */

/**
 * @typedef {Object} ChatPreferences
 * @property {string} baseSystemPrompt
 * @property {string[]} [disabledTools] — in den Einstellungen abgewählte Tools
 * @property {number} [maxToolRounds]
 * @property {number} [historyCharLimit]
 */

/**
 * @typedef {Object} ChatPreferencesPort
 * @property {() => Promise<ChatPreferences>} read
 */

module.exports = {};
