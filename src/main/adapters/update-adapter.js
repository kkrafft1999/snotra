'use strict';

function createUpdateAdapter(updateService) {
  return {
    getCurrentVersion() {
      return updateService.getCurrentVersion();
    },
    checkForUpdate(options) {
      return updateService.checkForUpdate(options);
    },
    ignoreVersion(version) {
      return updateService.ignoreVersion(version);
    },
    downloadUpdate(options) {
      return updateService.downloadUpdate(options);
    },
    cancelDownload() {
      return updateService.cancelDownload();
    },
    discardDownload() {
      return updateService.discardDownload();
    },
    installUpdate() {
      return updateService.installUpdate();
    },
    takeInstallFailure() {
      return updateService.takeInstallFailure();
    },
  };
}

/**
 * The update check as the app runs it: silently after the start, or because
 * the user chose "Check for updates" in the menu. The answer goes to the main
 * window as `UPDATE_AVAILABLE`; the silent check only speaks up when there is
 * something to show.
 *
 * @param {object} deps
 * @param {object} deps.updates        the adapter above, or a test double
 * @param {() => object|null} deps.getMainWindow
 * @param {object} deps.PUSH
 * @param {object} [deps.env]  only `SNOTRA_NO_UPDATE_CHECK` is read: set to
 *   `1`, the silent check does not ask GitHub (#407). The smoke test sets it,
 *   so a release published in the meantime cannot put the update dialog over
 *   the window it takes screenshots of.
 */
function createUpdateCheck({ updates, getMainWindow, PUSH, env = process.env }) {
  return async function runUpdateCheck({ silent }) {
    // Only the automatic check steps aside. Choosing "Check for updates" in
    // the menu is an explicit request and still gets an answer.
    if (silent && env.SNOTRA_NO_UPDATE_CHECK === '1') return;
    // A swap that failed after the last quit is told on the next start, and
    // only then (#442).
    const lastInstallFailure = silent && typeof updates.takeInstallFailure === 'function'
      ? await updates.takeInstallFailure()
      : null;
    const result = await updates.checkForUpdate({ respectIgnored: silent && !lastInstallFailure });
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (silent && !result.updateAvailable) return;
    win.webContents.send(PUSH.UPDATE_AVAILABLE, { ...result, lastInstallFailure, manual: !silent });
  };
}

module.exports = {
  createUpdateAdapter,
  createUpdateCheck,
};
