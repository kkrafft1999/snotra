'use strict';

/**
 * The pairing of the mobile remote, for the window (#1114; the panel is
 * #1110). The renderer starts, cancels and removes, and is told every change;
 * it takes no argument and is never asked for one — not even the *Allow*,
 * which main gets from the person at the desktop through the native dialog
 * of the user-confirmation port (#980).
 *
 * What goes back is normalized on the way out (contracts/remote/pairing-state.js):
 * no key, no token and no channel id reaches the window.
 *
 * Next to it the switch *Access from your phone* (#1195): the workspaces open
 * to the phone, read and changed by root. Opening one is confirmed by main in
 * the native dialog; the window only says which folder and which way.
 */

const {
  normalizeRemotePairingResult,
  normalizeRemotePairingState,
} = require('../../shared/contracts/remote/pairing-state');
const { withQrModules } = require('../remote/pairing-qr');

/**
 * @param {{
 *   ipcMain: import('./trusted-sender').GuardedIpcMain,
 *   pairing: {
 *     getState: () => Promise<unknown>, start: () => Promise<unknown>, cancel: () => Promise<unknown>,
 *     unpair: () => Promise<unknown>, subscribe: (listener: (state: unknown) => void) => unknown,
 *   },
 *   releaseSettings?: {
 *     getState: () => Promise<{ available: boolean, paired: boolean, released: string[] }>,
 *     setReleased: (root: unknown, released: unknown) => Promise<unknown>,
 *     subscribe: (listener: () => void) => unknown,
 *   } | null,
 *   workspaceSwitch?: { answer: (payload: unknown) => void } | null,
 *   pushToWindow: (channel: string, payload?: unknown) => boolean,
 *   REQ: Record<string, string>,
 *   PUSH: Record<string, string>,
 * }} deps  without `releaseSettings` only the pairing is registered; `workspaceSwitch` takes the
 *   window's answer to a folder the phone asked to open (#1194)
 */
function registerRemoteHandlers({ ipcMain, pairing, releaseSettings = null, workspaceSwitch = null, pushToWindow, REQ, PUSH }) {
  // The QR code is drawn here and goes along as modules: the window only paints it (#1110).
  const forWindow = (/** @type {unknown} */ state) => normalizeRemotePairingState(withQrModules(normalizeRemotePairingState(state)));
  pairing.subscribe((state) => pushToWindow(PUSH.REMOTE_STATE, forWindow(state)));

  ipcMain.handle(REQ.REMOTE_GET_STATE, async () => forWindow(await pairing.getState()));
  ipcMain.handle(REQ.REMOTE_PAIR_START, async () => normalizeRemotePairingResult(await pairing.start()));
  ipcMain.handle(REQ.REMOTE_PAIR_CANCEL, async () => normalizeRemotePairingResult(await pairing.cancel()));
  ipcMain.handle(REQ.REMOTE_UNPAIR, async () => normalizeRemotePairingResult(await pairing.unpair()));
  // The window's answer to a folder the phone asked to open (#1194).
  if (workspaceSwitch) ipcMain.on(REQ.WORKSPACE_SWITCH_ANSWER, (_event, answer) => workspaceSwitch.answer(answer));

  if (!releaseSettings) return;
  // A pairing that comes or goes changes the line under the switch as well.
  pairing.subscribe(() => pushToWindow(PUSH.REMOTE_RELEASE_CHANGED));
  releaseSettings.subscribe(() => pushToWindow(PUSH.REMOTE_RELEASE_CHANGED));
  ipcMain.handle(REQ.REMOTE_RELEASE_GET, async () => normalizeReleaseView(await releaseSettings.getState()));
  ipcMain.handle(REQ.REMOTE_RELEASE_SET, (_event, root, released) => releaseSettings.setReleased(root, released));
}

/**
 * @param {unknown} view
 * @returns {{ available: boolean, paired: boolean, released: string[] }}
 */
function normalizeReleaseView(view) {
  const raw = /** @type {{ available?: unknown, paired?: unknown, released?: unknown } | null} */ (view);
  return {
    available: raw?.available === true,
    paired: raw?.paired === true,
    released: Array.isArray(raw?.released) ? raw.released.filter((root) => typeof root === 'string' && root !== '') : [],
  };
}

module.exports = { registerRemoteHandlers };
