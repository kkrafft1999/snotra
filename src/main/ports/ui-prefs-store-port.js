/**
 * UI-Präferenzen-Persistenz.
 *
 * @typedef {import('../../shared/contracts/settings').UiPrefs} UiPrefs
 *
 * @typedef {Object} UiPrefsStorePort
 * @property {() => Promise<UiPrefs>} readUIPrefs
 * @property {(updater: (prefs: UiPrefs) => UiPrefs|Promise<UiPrefs>, options?: { confirmations?: Record<string, unknown> }) => Promise<UiPrefs>} updateUIPrefs
 *   `confirmations`: the receipts for execution tools switched on, keyed by preference (#1104)
 */

module.exports = {};
