'use strict';

const { createTranslator } = require('../shared/i18n');

/**
 * The parts of the start-up in `index.js` that decide something, kept apart
 * so they can be tested with an injected `app` (#507, #509).
 */

/**
 * One Snotra per userData folder (#507). A second process on the same folder
 * would sit outside the in-process locks of the stores — two saves at nearly
 * the same moment drop each other's change — start its own MCP servers,
 * watchers and sandbox proxy, and run from an app a self-update is swapping.
 *
 * Electron holds the lock per userData folder, so the e2e tests, which each
 * start with their own `--user-data-dir`, do not get in each other's way.
 *
 * @returns {boolean} true when this process is the one that runs; false when
 *   another instance already does — this one has been told to quit and must
 *   start nothing.
 */
function claimSingleInstance({ app, getMainWindow, createWindow, canCreateWindow = () => true }) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  // Emitted in the running instance when another one is launched, and only
  // after `ready`.
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
    // macOS keeps running without a window. Before the application is built
    // the start-up creates the window itself; a second one would come
    // without its IPC handlers.
    if (canCreateWindow()) createWindow();
  });
  return true;
}

/**
 * A start-up that throws must not leave a process without a window behind
 * (#509): on macOS a dock icon that does nothing, on Windows and Linux an
 * invisible process. The error is logged, shown, and the app ends.
 */
function createStartupFailureHandler({ app, dialog, log = console, appName = 'Snotra AI' }) {
  return (error) => {
    log.error?.('Start-up failed:', error);
    try {
      // The stored language is not known yet; the system's is the best guess.
      const t = createTranslator(String(app.getLocale?.() || '').slice(0, 2));
      dialog.showErrorBox(
        t('app.startupFailed.title', { appName }),
        // The stack is in the log; the box carries the sentence.
        t('app.startupFailed.message', { detail: String(error?.message || error) }),
      );
    } catch {
      // Without a dialog the log is all there is.
    }
    app.exit(1);
  };
}

module.exports = { claimSingleInstance, createStartupFailureHandler };
