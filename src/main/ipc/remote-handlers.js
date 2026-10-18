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
 */

const {
  normalizeRemotePairingResult,
  normalizeRemotePairingState,
} = require('../../shared/contracts/remote/pairing-state');

/**
 * @param {{
 *   ipcMain: { handle: (channel: string, handler: Function) => void },
 *   pairing: {
 *     getState: () => Promise<unknown>, start: () => Promise<unknown>, cancel: () => Promise<unknown>,
 *     unpair: () => Promise<unknown>, subscribe: (listener: (state: unknown) => void) => unknown,
 *   },
 *   pushToWindow: (channel: string, payload?: unknown) => boolean,
 *   REQ: Record<string, string>,
 *   PUSH: Record<string, string>,
 * }} deps
 */
function registerRemoteHandlers({ ipcMain, pairing, pushToWindow, REQ, PUSH }) {
  pairing.subscribe((state) => pushToWindow(PUSH.REMOTE_STATE, normalizeRemotePairingState(state)));

  ipcMain.handle(REQ.REMOTE_GET_STATE, async () => normalizeRemotePairingState(await pairing.getState()));
  ipcMain.handle(REQ.REMOTE_PAIR_START, async () => normalizeRemotePairingResult(await pairing.start()));
  ipcMain.handle(REQ.REMOTE_PAIR_CANCEL, async () => normalizeRemotePairingResult(await pairing.cancel()));
  ipcMain.handle(REQ.REMOTE_UNPAIR, async () => normalizeRemotePairingResult(await pairing.unpair()));
}

module.exports = { registerRemoteHandlers };
