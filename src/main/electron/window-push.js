'use strict';

/**
 * The event-push port on the desktop (#983): a push to the app window — if
 * there is one. Before the window opens and after it closes, a push has
 * nobody to go to and is dropped.
 *
 * @param {() => (Electron.BrowserWindow|null|undefined)} getMainWindow
 * @returns {import('../../application/ports/event-push-port').EventPushPort}
 */
function createWindowPush(getMainWindow) {
  return {
    push(channel, payload = {}) {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return false;
      win.webContents.send(channel, payload);
      return true;
    },
  };
}

module.exports = { createWindowPush };
