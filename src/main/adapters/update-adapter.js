'use strict';

/**
 * @returns {import('../ports/update-port').UpdatePort}
 */
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
    readInstallFailure() {
      return updateService.readInstallFailure();
    },
    clearInstallFailure() {
      return updateService.clearInstallFailure();
    },
    confirmInstallStarted() {
      return updateService.confirmInstallStarted();
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
 * @param {import('../ports/update-port').UpdatePort} deps.updates  the adapter above, or a test double
 * @param {() => { isDestroyed: () => boolean, webContents: { send: Function } }|null} deps.getMainWindow
 * @param {{ UPDATE_AVAILABLE: string }} deps.PUSH
 * @param {() => Promise<boolean>|boolean} [deps.isAutomaticCheckEnabled]
 *   the setting *Check for updates at start-up* (#987). Off, the silent check
 *   does not ask GitHub; the check from the menu is not affected.
 * @param {NodeJS.ProcessEnv} [deps.env]  only `SNOTRA_NO_UPDATE_CHECK` is read: set to
 *   `1`, the silent check does not ask GitHub (#407). The smoke test sets it,
 *   so a release published in the meantime cannot put the update dialog over
 *   the window it takes screenshots of.
 */
function createUpdateCheck({
  updates, getMainWindow, PUSH, isAutomaticCheckEnabled = () => true, env = process.env,
}) {
  /** @param {{ silent?: boolean }} options */
  return async function runUpdateCheck({ silent }) {
    // Only the automatic check steps aside. Choosing "Check for updates" in
    // the menu is an explicit request and still gets an answer.
    if (silent && env.SNOTRA_NO_UPDATE_CHECK === '1') return;
    if (silent && (await isAutomaticCheckEnabled()) === false) return;
    // A swap that failed after the last quit is told on the next start (#442)
    // — on the first start that actually gets to show it. Until then the
    // record stays: a check that cannot reach GitHub shows nothing (#573).
    const lastInstallFailure = silent && typeof updates.readInstallFailure === 'function'
      ? await updates.readInstallFailure()
      : null;
    const result = await updates.checkForUpdate({ respectIgnored: silent && !lastInstallFailure });
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (silent && !result.updateAvailable) return;
    win.webContents.send(PUSH.UPDATE_AVAILABLE, { ...result, lastInstallFailure, manual: !silent });
    if (lastInstallFailure) await updates.clearInstallFailure?.();
  };
}

module.exports = {
  createUpdateAdapter,
  createUpdateCheck,
};
