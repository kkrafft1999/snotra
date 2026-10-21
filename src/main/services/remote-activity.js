'use strict';

/**
 * What happens on the desktop that the remote front ends follow (#1194): the
 * events of every running turn by chat, and switches of the open workspace.
 *
 * In step 1 of `docs/remote-interface.md` §10 a turn's events are published
 * from where `chat-handlers.js` forwards them to the window (§8.2); the
 * workspace switch from `workspace-activation.js`'s hook. The remote bridge
 * listens through the desktop port. A listener that throws is logged and
 * the others still hear of it — the window's run never waits on a remote.
 */

/**
 * @param {{ log?: { warn: (...args: unknown[]) => void } }} [deps]
 */
function createRemoteActivity({ log = console } = {}) {
  /** @type {Set<(activity: import('../../application/ports/remote-desktop-port').RemoteDesktopActivity) => void>} */
  const listeners = new Set();

  /** @param {import('../../application/ports/remote-desktop-port').RemoteDesktopActivity} activity */
  function tell(activity) {
    for (const listener of listeners) {
      try {
        listener(activity);
      } catch (error) {
        log.warn(`[remote] a listener of the desktop's activity failed (${error?.name || 'error'})`);
      }
    }
  }

  return {
    /**
     * One event of a running turn, as the window gets it.
     * @param {{ chatId: string|null, runId: string|null, type?: string, payload?: unknown }} event
     */
    publishRun({ chatId, runId, type, payload }) {
      if (typeof chatId !== 'string' || !chatId || typeof type !== 'string' || listeners.size === 0) return;
      const fields = payload && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
      tell({ kind: 'run', chatId, runId: typeof runId === 'string' ? runId : null, type, payload: fields });
    },
    workspaceChanged() {
      if (listeners.size) tell({ kind: 'workspace' });
    },
    /**
     * A card went out or was settled (#1194, step 3), as the tool approval
     * adapter observes it.
     * @param {{ type: 'request', chatId: string|null, dto: object }
     *   | { type: 'resolved', requestId: string, chatId: string|null, response: string|null, invalidated: boolean,
     *       reason: string|null, by: { kind: string, client?: string } | null }} event
     */
    publishApproval(event) {
      if (listeners.size) tell(/** @type {any} */ ({ kind: 'approval', ...event }));
    },
    /** @param {(activity: import('../../application/ports/remote-desktop-port').RemoteDesktopActivity) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

module.exports = { createRemoteActivity };
