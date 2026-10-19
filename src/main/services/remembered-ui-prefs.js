'use strict';

/**
 * The two preferences the main process needs synchronously: the interface
 * language (epic #277) and whether the tree shows hidden files (#436).
 *
 * The menu bar and the context menu are built synchronously; an `await` on the
 * preferences would mean a menu opening without labels or with the wrong tick.
 * Hence remembered values, read once at start and written forward by the
 * settings. Whoever builds the menu hears of every change through the two
 * callbacks.
 */

const { DEFAULT_LOCALE, normalizeLocale } = require('../../shared/i18n');

/**
 * @param {Object} deps
 * @param {Pick<import('../ports/ui-prefs-store-port').UiPrefsStorePort, 'readUIPrefs'>} deps.uiPrefsStore
 * @param {((locale: string) => void)|null} [deps.onAppLocaleChanged]
 * @param {((show: boolean) => void)|null} [deps.onShowHiddenFilesChanged]
 */
function createRememberedUiPrefs({ uiPrefsStore, onAppLocaleChanged = null, onShowHiddenFilesChanged = null }) {
  let appLocale = DEFAULT_LOCALE;
  let showHiddenFiles = false;
  let showHiddenFilesSet = false;

  /** A language change takes effect at once: the caller rebuilds the menu, since Electron cannot rename an item. */
  /** @param {unknown} next */
  function setAppLocale(next) {
    appLocale = normalizeLocale(next);
    onAppLocaleChanged?.(appLocale);
  }

  /** @param {unknown} next */
  function setShowHiddenFiles(next) {
    showHiddenFilesSet = true;
    showHiddenFiles = next === true;
    onShowHiddenFilesChanged?.(showHiddenFiles);
  }

  // The first menu is already in place while the file is still being read. If
  // the stored language differs, the caller rebuilds it now — long before
  // anyone opens it.
  const localeRead = uiPrefsStore.readUIPrefs()
    .then((prefs) => {
      const stored = normalizeLocale(prefs.appLocale);
      if (stored !== appLocale) setAppLocale(stored);
    })
    .catch(() => {});

  // The renderer owns the hidden-files switch; the main process remembers it
  // only for the checkbox in the View menu, which starts unticked. A toggle
  // that beats the start-up read wins — it is the newer wish.
  const hiddenFilesRead = uiPrefsStore.readUIPrefs()
    .then((prefs) => {
      if (!showHiddenFilesSet && prefs.showHiddenFiles === true) setShowHiddenFiles(true);
    })
    .catch(() => {});

  return {
    getAppLocale: () => appLocale,
    setAppLocale,
    getShowHiddenFiles: () => showHiddenFiles,
    setShowHiddenFiles,
    /** Settles once both start-up reads are done; for tests. */
    whenRead: () => Promise.all([localeRead, hiddenFilesRead]).then(() => {}),
  };
}

module.exports = {
  createRememberedUiPrefs,
};
