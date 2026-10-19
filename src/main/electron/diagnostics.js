'use strict';

const { DEFAULT_LOCALE, createTranslator } = require('../../shared/i18n');
const { buildDiagnosticsReport } = require('../services/diagnostics-report');

/**
 * Copy diagnostics and show the log (#978), from the Help menu and from the
 * background-error notice. Both ends call the same two functions, so the
 * clipboard holds the same report whichever way it was asked for.
 *
 * @param {object} deps
 * @param {Pick<import('electron').App, 'getVersion'>} deps.app
 * @param {Pick<typeof import('os'), 'release' | 'homedir'>} deps.os
 * @param {{ platform: string, arch: string, versions: Readonly<Record<string, string|undefined>> }} [deps.processInfo]
 * @param {{ filePath: string, tail: (count: number) => string[] }|null} deps.logFile
 * @param {{ count?: () => number }|null} [deps.reporter]
 * @param {Pick<import('electron').Clipboard, 'writeText'>} deps.clipboard
 * @param {Pick<import('electron').Shell, 'showItemInFolder'>} deps.shell
 * @param {Pick<import('electron').Dialog, 'showMessageBox'>|null} [deps.dialog]
 * @param {() => import('electron').BrowserWindow|null} [deps.getMainWindow]
 * @param {() => string|undefined} [deps.getLocale]
 * @param {string} [deps.appName]
 * @param {{ error?: (...args: unknown[]) => void }|null} [deps.log]
 */
function createDiagnostics({
  app,
  os,
  processInfo = process,
  logFile,
  reporter,
  clipboard,
  shell,
  dialog = null,
  getMainWindow = () => null,
  getLocale = () => DEFAULT_LOCALE,
  appName = 'Snotra Agent',
  log = console,
}) {
  function report() {
    return buildDiagnosticsReport({
      appName,
      appVersion: app.getVersion(),
      platform: processInfo.platform,
      arch: processInfo.arch,
      osRelease: os.release(),
      versions: processInfo.versions,
      locale: getLocale?.() || '',
      errorCount: reporter?.count?.() ?? 0,
      logFile,
      homeDir: os.homedir(),
    });
  }

  /** Puts the report on the clipboard; false when that failed (logged). */
  function copy() {
    try {
      clipboard.writeText(report());
      return true;
    } catch (error) {
      log?.error?.('[diagnostics] Could not copy the diagnostics:', error);
      return false;
    }
  }

  /** Shows the log file in the file manager; false when there is none to show. */
  function revealLog() {
    if (!logFile?.filePath || typeof shell?.showItemInFolder !== 'function') return false;
    shell.showItemInFolder(logFile.filePath);
    return true;
  }

  /**
   * *Help › Copy diagnostics*. A menu item gives no sign that it did
   * anything, so a box says that the report is on the clipboard and what is
   * in it — it may end up in a public issue — and offers the log file.
   */
  async function copyFromMenu() {
    const ok = copy();
    if (!dialog) return ok;
    const t = createTranslator(getLocale?.() || DEFAULT_LOCALE);
    /** @type {import('electron').MessageBoxOptions} */
    const options = ok
      ? {
        type: 'info',
        message: t('diagnostics.copied.title'),
        detail: t('diagnostics.copied.detail'),
        buttons: [t('diagnostics.ok'), t('diagnostics.showLog')],
      }
      : {
        type: 'error',
        message: t('diagnostics.copyFailed.title'),
        detail: t('diagnostics.copyFailed.detail'),
        buttons: [t('diagnostics.ok'), t('diagnostics.showLog')],
      };
    try {
      const win = getMainWindow?.();
      const { response } = win && !win.isDestroyed?.()
        ? await dialog.showMessageBox(win, { ...options, defaultId: 0, cancelId: 0, noLink: true })
        : await dialog.showMessageBox({ ...options, defaultId: 0, cancelId: 0, noLink: true });
      if (response === 1) revealLog();
    } catch (error) {
      log?.error?.('[diagnostics] Could not show the confirmation:', error);
    }
    return ok;
  }

  return { report, copy, copyFromMenu, revealLog };
}

module.exports = { createDiagnostics };
