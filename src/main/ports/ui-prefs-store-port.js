/**
 * UI-Präferenzen-Persistenz.
 *
 * @typedef {import('../../shared/contracts/settings').UiPrefs} UiPrefs
 *
 * @typedef {Object} UiPrefsStorePort
 * @property {() => Promise<UiPrefs>} readUIPrefs
 * @property {(updater: (prefs: UiPrefs) => UiPrefs|Promise<UiPrefs>) => Promise<UiPrefs>} updateUIPrefs
 */

module.exports = {};
