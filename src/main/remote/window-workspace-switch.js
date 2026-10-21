'use strict';

/**
 * The phone opens another folder through the window (#1194, step 2c of
 * `docs/remote-interface.md` §10). The window switches folders itself
 * (`FileTree.openProject`): it settles the file on show first, and draws the
 * tree and the chat of the new folder. So main asks it on
 * `workspace:switch-requested` and waits for its answer on
 * `workspace:switch-answer`, rather than switching underneath it.
 *
 * Outcomes: `switched`; `unsaved` — the file on show has unsaved changes,
 * and nobody may be there to answer a dialog (decided 2026-10-20);
 * `refused` — the window did not open it; `no-answer` — none came in time;
 * `no-window` — there is no window to ask.
 */

/** @typedef {'switched' | 'unsaved' | 'refused' | 'no-answer' | 'no-window'} WindowSwitchOutcome */

const ANSWERS = new Set(['switched', 'unsaved', 'refused']);
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {{
 *   push: (channel: string, payload: object) => boolean,
 *   PUSH: { WORKSPACE_SWITCH_REQUESTED: string },
 *   randomUUID: () => string,
 *   timeoutMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 * }} deps
 */
function createWindowWorkspaceSwitch({
  push,
  PUSH,
  randomUUID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(/** @type {any} */ (timer)),
}) {
  /** @type {Map<string, (outcome: WindowSwitchOutcome) => void>} */
  const pending = new Map();

  return {
    /**
     * @param {string} folderPath  a folder main knows; the window activates it as from its menu
     * @returns {Promise<WindowSwitchOutcome>}
     */
    switchTo(folderPath) {
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimer(() => settle('no-answer'), timeoutMs);
        /** @param {WindowSwitchOutcome} outcome */
        function settle(outcome) {
          if (!pending.delete(requestId)) return;
          clearTimer(timer);
          resolve(outcome);
        }
        pending.set(requestId, settle);
        if (!push(PUSH.WORKSPACE_SWITCH_REQUESTED, { requestId, folderPath })) settle('no-window');
      });
    },

    /**
     * The window's answer. One that names no open request, or an outcome the
     * window cannot give, changes nothing.
     * @param {unknown} payload
     */
    answer(payload) {
      const { requestId, outcome } = /** @type {{ requestId?: unknown, outcome?: unknown }} */ (payload ?? {});
      const settle = typeof requestId === 'string' ? pending.get(requestId) : undefined;
      if (!settle) return;
      settle(typeof outcome === 'string' && ANSWERS.has(outcome) ? /** @type {WindowSwitchOutcome} */ (outcome) : 'refused');
    },
  };
}

module.exports = { createWindowWorkspaceSwitch };
