'use strict';

const { isTrustedRendererUrl } = require('../permissions');

/**
 * Item 17 of the Electron security checklist: every IPC message is checked
 * for who sent it (#509). Only the top frame of the app's own renderer page
 * may call main.
 *
 * Today only that frame gets the preload, and navigation is locked to the
 * renderer URL, so nothing else can reach `ipcRenderer`. The check makes the
 * boundary hold once the app shows other web content as well (#479), instead
 * of resting on how the window happens to be built.
 */
function isTrustedIpcSender(event) {
  let frame;
  try {
    frame = event?.senderFrame;
  } catch {
    return false;
  }
  // `senderFrame` is null once the frame navigated away or was destroyed.
  if (!frame) return false;
  if (frame.parent) return false;
  return isTrustedRendererUrl(frame.url);
}

/**
 * Wraps `ipcMain` so that every handler registered through it refuses an
 * untrusted sender before it runs. One place at registration, so no handler
 * can forget it. `handle` rejects the call; `on` drops the message.
 */
function guardIpcMain(ipcMain, { isTrustedSender = isTrustedIpcSender, log = console } = {}) {
  const refuse = (channel) => log.warn?.(`IPC refused on ${channel}: the sender is not the app window.`);
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedSender(event)) {
          refuse(channel);
          throw new Error('The sender is not the app window.');
        }
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (!isTrustedSender(event)) {
          refuse(channel);
          return;
        }
        listener(event, ...args);
      });
    },
  };
}

module.exports = { guardIpcMain, isTrustedIpcSender };
