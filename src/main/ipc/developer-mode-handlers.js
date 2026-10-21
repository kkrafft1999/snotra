'use strict';

/**
 * Developer mode (#1213) for the window: read it, switch it with the
 * shortcut, and hear every change.
 *
 * @param {{
 *   ipcMain: import('./trusted-sender').GuardedIpcMain,
 *   developerMode: { isOn: () => boolean, toggle: () => Promise<boolean>, subscribe: (listener: (on: boolean) => void) => unknown },
 *   pushToWindow: (channel: string, payload?: unknown) => boolean,
 *   REQ: Record<string, string>,
 *   PUSH: Record<string, string>,
 * }} deps
 */
function registerDeveloperModeHandlers({ ipcMain, developerMode, pushToWindow, REQ, PUSH }) {
  developerMode.subscribe((on) => pushToWindow(PUSH.DEVELOPER_MODE_CHANGED, { on: on === true }));
  ipcMain.handle(REQ.DEVELOPER_MODE_GET, async () => ({ on: developerMode.isOn() === true }));
  ipcMain.handle(REQ.DEVELOPER_MODE_TOGGLE, async () => ({ on: (await developerMode.toggle()) === true }));
}

module.exports = { registerDeveloperModeHandlers };
