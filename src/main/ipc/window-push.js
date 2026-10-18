'use strict';

/**
 * Sends a push to the app window — if there is one. Before the window opens
 * and after it closes, a push has nobody to go to and is dropped.
 *
 * @param {() => (Electron.BrowserWindow|null|undefined)} getMainWindow
 * @returns {(channel: string, payload?: unknown) => boolean}  whether it was sent
 */
function createWindowPush(getMainWindow) {
  return (channel, payload = {}) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    win.webContents.send(channel, payload);
    return true;
  };
}

module.exports = { createWindowPush };
