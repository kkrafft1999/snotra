/**
 * ChatPreferences-Port: schmale UI-Prefs-Schnittstelle für den Chat-Core.
 */

/**
 * @typedef {Object} ChatPreferences
 * @property {string} baseSystemPrompt
 * @property {string[]} [disabledTools] — in den Einstellungen abgewählte Tools
 * @property {number} [maxToolRounds]
 * @property {number} [historyCharLimit]
 * @property {string} [appLocale]  the interface language; unset means the app default (#277)
 * @property {string[]|null} [activeSkills]  the switched-on skills; null means the default set
 * @property {boolean} [environmentInfoEnabled]  false leaves the environment block out (#138)
 * @property {boolean} [projectInstructionsEnabled]  false leaves AGENTS.md out (#212)
 * @property {boolean} [memoryWorkspaceEnabled]  false leaves the folder's memory out (#166)
 * @property {boolean} [memoryUserEnabled]  false leaves the user's memory out (#166)
 */

/**
 * @typedef {Object} ChatPreferencesPort
 * @property {() => Promise<ChatPreferences>} read
 */

module.exports = {};
