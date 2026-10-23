'use strict';

/**
 * Whether the main window says a phone is connected, and whether the desktop
 * stays awake for it (#1196, requirement R8 of #1081).
 *
 * - **Connected** means both: a session stands (§17, `session.hello`) and the
 *   phone's heartbeat is fresh (§12.3). A session alone outlives a phone put
 *   in a pocket by up to a day; the heartbeat alone is no connection.
 * - **No flicker:** once that ends, the window keeps saying *connected* for
 *   `DISCONNECT_GRACE_MS`, long enough for a phone that comes back to the
 *   foreground or changes networks to stand again. Removing the phone ends
 *   it at once (`end()`).
 * - **Staying awake** (concept §4.1): while the phone counts as connected
 *   **and** a run works, the power-save port holds; either ending lets it go.
 *   The window is told whether it holds, so the effect is not silent either.
 */

/** How long *connected* outlasts the session or the heartbeat that ended. */
const DISCONNECT_GRACE_MS = 10_000;

/**
 * The one rule for staying awake.
 * @param {{ connected: boolean, working: boolean }} state
 */
function keepAwakeWanted({ connected, working }) {
  return connected === true && working === true;
}

/**
 * @typedef {{ connected: boolean, keepingAwake: boolean }} RemotePresenceState
 */

/**
 * @param {{
 *   powerSave?: import('../ports/power-save-port').PowerSavePort | null,
 *   graceMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} [deps]  without `powerSave` nothing is kept awake, and the window is not told it is
 */
function createRemotePresence({
  powerSave = null,
  graceMs = DISCONNECT_GRACE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(/** @type {any} */ (timer)),
  log = console,
} = {}) {
  /** What the channel says right now. */
  let live = false;
  /** What the window shows: `live`, held for the grace after it ended. */
  let shown = false;
  let working = false;
  /** The power-save port's handle while it holds. */
  let blocker = /** @type {unknown} */ (null);
  let holding = false;
  /** @type {unknown} */
  let graceTimer = null;
  let disposed = false;
  /** @type {RemotePresenceState} */
  let last = { connected: false, keepingAwake: false };
  /** @type {Set<(state: RemotePresenceState) => void>} */
  const listeners = new Set();

  const snapshot = () => ({ connected: shown, keepingAwake: holding });

  function stopGrace() {
    if (graceTimer !== null) clearTimer(graceTimer);
    graceTimer = null;
  }

  function release() {
    if (!holding) return;
    holding = false;
    const handle = blocker;
    blocker = null;
    try {
      powerSave?.release(handle);
    } catch (error) {
      log.warn(`[remote] letting the computer sleep again failed (${error?.name || 'error'})`);
    }
  }

  function follow() {
    if (disposed) return;
    const wanted = keepAwakeWanted({ connected: shown, working });
    if (wanted && !holding && powerSave) {
      try {
        blocker = powerSave.hold();
        holding = true;
      } catch (error) {
        // Not kept awake, so the window does not say it is.
        log.warn(`[remote] keeping the computer awake failed (${error?.name || 'error'})`);
      }
    } else if (!wanted) {
      release();
    }
    const state = snapshot();
    if (state.connected === last.connected && state.keepingAwake === last.keepingAwake) return;
    last = state;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        log.warn(`[remote] a presence listener failed (${error?.name || 'error'})`);
      }
    }
  }

  /**
   * The channel's word: whether a session stands with a phone whose heartbeat is fresh.
   * @param {boolean} value
   */
  function setConnected(value) {
    live = value === true;
    if (live) {
      stopGrace();
      shown = true;
    } else if (shown && graceTimer === null) {
      graceTimer = setTimer(() => {
        graceTimer = null;
        if (live) return;
        shown = false;
        follow();
      }, graceMs);
    }
    follow();
  }

  /**
   * Whether any run works right now, on the desktop or started from the phone.
   * @param {boolean} value
   */
  function setWorking(value) {
    working = value === true;
    follow();
  }

  /**
   * The chats with a run going, as the chat engine counts them: working while there is any.
   * @param {Iterable<unknown>} chatIds
   */
  function setRunningChats(chatIds) {
    setWorking([...chatIds].length > 0);
  }

  /** The phone was removed: no grace for a connection that cannot come back. */
  function end() {
    live = false;
    stopGrace();
    shown = false;
    follow();
  }

  /** @param {(state: RemotePresenceState) => void} listener */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** At quit: the computer may sleep again. */
  function dispose() {
    if (disposed) return;
    stopGrace();
    release();
    disposed = true;
    listeners.clear();
  }

  return { setConnected, setWorking, setRunningChats, end, getState: snapshot, subscribe, dispose };
}

module.exports = { createRemotePresence, keepAwakeWanted, DISCONNECT_GRACE_MS };
