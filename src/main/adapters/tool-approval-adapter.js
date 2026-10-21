'use strict';

/**
 * Approval-Port-Adapter (Issue #66, Konzept §6): Freigabe-Karten über IPC.
 *
 * Der Renderer meldet sich pro Fenster als freigabefähig an — mit einem
 * Push-Ziel (`EventPushTarget`, #983; unter Electron das `target`).
 * Ohne Anmeldung gibt es keine Karte und jede Anfrage verfällt sofort
 * (fail-safe). Jede Anfrage erhält eine zufällige `requestId` und ist an
 * Sitzung (Sender-ID), Plan und Policy-Version gebunden. Eine Antwort wird
 * nur akzeptiert, wenn sie vom selben Sender kommt, die Anfrage offen ist und
 * nichts außer der Entscheidung enthält. Doppelte, fremde und verspätete
 * Antworten geben nichts frei.
 *
 * Kein Zeitlimit: Eine Karte wartet, bis der Nutzer entscheidet. Verfall nur
 * durch Abbruch, Fenster-Schließen, Kontext-/Regelwechsel (invalidate*).
 */

const {
  APPROVAL_RESPONSES,
  PERMISSION_DENIAL_REASONS,
  createToolApprovalRequestDto,
  isApprovalResponse,
  isPermissionDenialReason,
} = require('../../shared/contracts/tool-permissions');
const { createMessage } = require('../../shared/contracts/message');
const { isRecord } = require('../../shared/runtime/is-record');

/**
 * @typedef {import('../../application/ports/tool-approval-port').ToolApprovalRequest} ToolApprovalRequest
 * @typedef {import('../../application/ports/tool-approval-port').ToolApprovalOutcome} ToolApprovalOutcome
 * A window that registered for cards; checked again before every push.
 * @typedef {Partial<import('../../application/ports/event-push-port').EventPushTarget>} ApprovalWindow
 *
 * An open request: who asked, for which chat, and how to answer the waiting call.
 * @typedef {Object} PendingApproval
 * @property {string|number} sessionId
 * @property {string|null} chatId
 * @property {ToolApprovalRequest} request
 * @property {(outcome: ToolApprovalOutcome) => void} resolve
 * @property {() => void} cleanup
 */

/**
 * Who answered a card (`docs/remote-interface.md` §7.4): the window, or a
 * remote front end by its kind and the name it gave.
 * @typedef {{ kind: string, client?: string }} ApprovalAnswerer
 *
 * What a remote front end hears of the cards (#1194, step 3): a card that
 * went out, as its DTO, and a card that was settled — by whom, when it was
 * answered rather than voided.
 * @typedef {{ type: 'request', chatId: string|null, dto: object }
 *   | { type: 'resolved', requestId: string, chatId: string|null, response: string|null, invalidated: boolean,
 *       reason: string|null, by: ApprovalAnswerer|null }} ApprovalEvent
 */

/** The answers a remote front end may give (§7.4): nothing that stores or widens. */
/** @type {Set<string>} */
const REMOTE_RESPONSES = new Set([APPROVAL_RESPONSES.ALLOW_ONCE, APPROVAL_RESPONSES.DENY]);

/**
 * @param {unknown} chatId
 * @returns {string|null}
 */
function chatKey(chatId) {
  return typeof chatId === 'string' && chatId ? chatId : null;
}

/**
 * Why an aborted request expired: the abort's own reason when it names one
 * (#792 — the command behind a sandbox card gave up waiting), otherwise the
 * general one.
 *
 * @param {AbortSignal|undefined} signal
 */
function abortReason(signal) {
  return isPermissionDenialReason(signal?.reason) ? signal.reason : PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED;
}

/**
 * The port, plus the side the IPC layer talks to: windows subscribe, the
 * renderer answers, and main lists what is still open.
 *
 * @param {Object} deps
 * @param {() => string} deps.randomUUID
 * @param {{ TOOL_APPROVAL_REQUEST: string, TOOL_APPROVAL_RESOLVED: string }} deps.PUSH
 * @param {{ warn?: Function }} [deps.log]
 * @param {(sessionId: string|number) => boolean} [deps.answeredByWindow]  a front end without cards of its
 *   own whose requests the app window answers — a phone's turn before it can answer them (#1194)
 * @returns {import('../../application/ports/tool-approval-port').ToolApprovalPort & {
 *   subscribe: (sessionId: string|number, target: ApprovalWindow) => boolean,
 *   unsubscribe: (sessionId: string|number) => void,
 *   respond: (sessionId: string|number, answer?: object) => { ok: boolean, error?: object, response?: string },
 *   getPendingRequest: (sessionId: string|number, requestId: string) => ToolApprovalRequest|null,
 *   invalidateChat: (chatId: string|null, reason?: string) => void,
 *   invalidateExceptChats: (chatIds: Iterable<string|null>, reason?: string) => void,
 *   invalidateAll: (reason?: string) => void,
 *   listPending: (sessionId?: string|number) => Array<object>,
 *   pendingCount: () => number,
 *   observe: (listener: (event: ApprovalEvent) => void) => () => void,
 *   respondFromRemote: (requestId: unknown, answer: { response?: unknown, sandboxPaths?: unknown }, by: ApprovalAnswerer) =>
 *     { ok: true, response: string } | { ok: false, reason: 'not-found' | 'refused' },
 * }}
 */
function createToolApprovalAdapter({ randomUUID, PUSH, log = console, answeredByWindow = () => false }) {
  /** @type {Map<string|number, ApprovalWindow>} sessionId → push target (nur angemeldete Fenster). */
  const subscribers = new Map();
  /** @type {Map<string, PendingApproval>} requestId → the open request */
  const pending = new Map();
  /** @type {Set<(event: ApprovalEvent) => void>} */
  const observers = new Set();

  /** @param {ApprovalEvent} event */
  function tell(event) {
    for (const observer of observers) {
      try {
        observer(event);
      } catch (error) {
        // A remote that cannot follow never holds up a card.
        log?.warn?.(`[tool-approval] an observer failed: ${error?.message || error}`);
      }
    }
  }

  /**
   * The session whose window answers a request of `sessionId`: its own, or —
   * for a front end without cards (#1194) — the window that subscribed
   * last. In the desktop app the window counts as subscribed to every chat
   * of its workspace (`docs/remote-interface.md` §7.4). The request is then
   * kept under the window's session, so that only it can answer.
   *
   * @param {string|number} sessionId
   */
  function answeringSession(sessionId) {
    if (subscribers.has(sessionId) || !answeredByWindow(sessionId)) return sessionId;
    let last = sessionId;
    for (const [id, target] of subscribers) {
      if (typeof target.isDestroyed === 'function' && target.isDestroyed()) continue;
      last = id;
    }
    return last;
  }

  /**
   * @param {ApprovalWindow|undefined} target
   * @param {string} channel
   * @param {object} payload
   */
  function send(target, channel, payload) {
    if (!target || typeof target.send !== 'function') return false;
    if (typeof target.isDestroyed === 'function' && target.isDestroyed()) return false;
    try {
      target.send(channel, payload);
      return true;
    } catch (error) {
      log?.warn?.(`[tool-approval] Senden fehlgeschlagen: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * @param {string} requestId
   * @param {ToolApprovalOutcome} outcome
   * @param {ApprovalAnswerer} [by]  who answered; the window unless a remote did
   */
  function settle(requestId, outcome, by = { kind: 'desktop' }) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    entry.cleanup?.();
    tell({
      type: 'resolved',
      requestId,
      chatId: entry.chatId,
      response: outcome.invalidated ? null : outcome.response ?? null,
      invalidated: outcome.invalidated === true,
      reason: outcome.reason || null,
      by: outcome.invalidated ? null : by,
    });
    const target = subscribers.get(entry.sessionId);
    if (target) {
      send(target, PUSH.TOOL_APPROVAL_RESOLVED, {
        requestId,
        response: outcome.invalidated ? null : outcome.response,
        invalidated: outcome.invalidated === true,
        reason: outcome.reason || null,
      });
    }
    entry.resolve({ ...outcome, requestId });
    return true;
  }

  /**
   * @param {string|number} sessionId
   * @param {string} [reason]
   */
  function invalidateSession(sessionId, reason = PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED) {
    for (const [requestId, entry] of [...pending.entries()]) {
      if (entry.sessionId === sessionId) settle(requestId, { invalidated: true, reason });
    }
  }

  /** @param {string} [reason] */
  function invalidateAll(reason = PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED) {
    for (const requestId of [...pending.keys()]) settle(requestId, { invalidated: true, reason });
  }

  /**
   * Open requests of one chat only — its mode changed, or it was deleted (#320).
   * @param {string|null} chatId
   * @param {string} [reason]
   */
  function invalidateChat(chatId, reason = PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED) {
    const key = chatKey(chatId);
    for (const [requestId, entry] of [...pending.entries()]) {
      if (entry.chatId === key) settle(requestId, { invalidated: true, reason });
    }
  }

  /**
   * Open requests of every chat except the given ones (#320). Those are the
   * visible chat and the chats still running in the background — a run that
   * waits for a card keeps waiting while the user looks at something else.
   * @param {Iterable<string|null>} chatIds
   * @param {string} [reason]
   */
  function invalidateExceptChats(chatIds, reason = PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED) {
    const keep = new Set([...chatIds].map(chatKey));
    for (const [requestId, entry] of [...pending.entries()]) {
      if (!keep.has(entry.chatId)) settle(requestId, { invalidated: true, reason });
    }
  }

  return {
    /** Renderer meldet sich als freigabefähig an; bei Zerstörung wieder ab. */
    subscribe(sessionId, target) {
      if (!target) return false;
      subscribers.set(sessionId, target);
      if (typeof target.once === 'function') {
        target.once('destroyed', () => {
          if (subscribers.get(sessionId) === target) subscribers.delete(sessionId);
          invalidateSession(sessionId, PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
        });
      }
      return true;
    },
    unsubscribe(sessionId) {
      subscribers.delete(sessionId);
      invalidateSession(sessionId, PERMISSION_DENIAL_REASONS.NO_APPROVAL_UI);
    },
    isAvailable(requestedBy) {
      const sessionId = answeringSession(requestedBy);
      const target = subscribers.get(sessionId);
      if (!target) return false;
      if (typeof target.isDestroyed === 'function' && target.isDestroyed()) {
        subscribers.delete(sessionId);
        return false;
      }
      return true;
    },
    requestApproval({ sessionId: requestedBy, request, abortSignal }) {
      const sessionId = answeringSession(requestedBy);
      const target = subscribers.get(sessionId);
      if (!this.isAvailable(sessionId)) {
        return Promise.resolve({ invalidated: true, reason: PERMISSION_DENIAL_REASONS.NO_APPROVAL_UI, requestId: '' });
      }
      if (abortSignal?.aborted) {
        return Promise.resolve({ invalidated: true, reason: abortReason(abortSignal), requestId: '' });
      }
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const onAbort = () => settle(requestId, { invalidated: true, reason: abortReason(abortSignal) });
        abortSignal?.addEventListener?.('abort', onAbort, { once: true });
        pending.set(requestId, {
          sessionId,
          chatId: chatKey(request?.chatId),
          request,
          resolve,
          cleanup: () => abortSignal?.removeEventListener?.('abort', onAbort),
        });
        const dto = createToolApprovalRequestDto({ ...request, requestId });
        if (!send(target, PUSH.TOOL_APPROVAL_REQUEST, dto)) {
          settle(requestId, { invalidated: true, reason: PERMISSION_DENIAL_REASONS.NO_APPROVAL_UI });
          return;
        }
        tell({ type: 'request', chatId: chatKey(request?.chatId), dto });
      });
    },
    /**
     * Antwort aus dem Renderer. Akzeptiert nur eine Entscheidung auf eine
     * eigene, offene Anfrage; alles andere ist ein Fehler ohne Wirkung.
     *
     * @param {string|number} sessionId
     * @param {{ requestId?: string, response?: string, ruleId?: string, sandboxPaths?: string[], workspaceStored?: boolean }} [answer]
     */
    respond(sessionId, { requestId, response, ruleId, sandboxPaths, workspaceStored } = {}) {
      const entry = typeof requestId === 'string' ? pending.get(requestId) : undefined;
      if (!entry || requestId === undefined) return { ok: false, error: createMessage('approval.error.noPending') };
      if (entry.sessionId !== sessionId) return { ok: false, error: createMessage('approval.error.otherWindow') };
      if (!isApprovalResponse(response)) {
        return { ok: false, error: createMessage('approval.error.invalidResponse') };
      }
      // A sandbox card (#792) opens paths: only those it offered, one per
      // resource; anything else is the first offer of that resource.
      const sandbox = entry.request?.sandbox;
      const offered = isRecord(sandbox) ? sandbox.entries : undefined;
      const paths = Array.isArray(offered) && response !== APPROVAL_RESPONSES.DENY
        ? {
            sandboxPaths: offered.map((e, i) => {
              const chosen = sandboxPaths?.[i];
              return chosen !== undefined && e.allow.includes(chosen) ? chosen : e.allow[0];
            }),
          }
        : {};
      if (
        (response === APPROVAL_RESPONSES.ALLOW_SESSION && entry.request?.sessionAllowed !== true) ||
        (response === APPROVAL_RESPONSES.ALLOW_ALWAYS && (entry.request?.alwaysAllowed !== true || !ruleId)) ||
        // "For this workspace" only where the card offered it and main stored it (#946).
        (response === APPROVAL_RESPONSES.ALLOW_WORKSPACE && (entry.request?.workspaceAllowed !== true || workspaceStored !== true))
      ) {
        // Die Karte bot die Option nicht an; als Einzelfreigabe behandeln.
        // "Always" without a stored rule is not "always" either (#121).
        settle(requestId, { response: APPROVAL_RESPONSES.ALLOW_ONCE, ...paths });
        return { ok: true, response: APPROVAL_RESPONSES.ALLOW_ONCE };
      }
      settle(requestId, response === APPROVAL_RESPONSES.ALLOW_ALWAYS ? { response, ruleId } : { response, ...paths });
      return { ok: true, response };
    },
    /**
     * The open request behind a card, for main's own use (#121): the IPC
     * handler reads the command rule from it before it asks natively. Null
     * for a request that is not open or belongs to another window.
     */
    getPendingRequest(sessionId, requestId) {
      const entry = pending.get(requestId);
      if (!entry || entry.sessionId !== sessionId) return null;
      return entry.request || null;
    },
    invalidateSession,
    invalidateAll,
    invalidateChat,
    invalidateExceptChats,
    listPending(sessionId) {
      return [...pending.entries()]
        .filter(([, entry]) => sessionId === undefined || entry.sessionId === sessionId)
        .map(([requestId, entry]) => createToolApprovalRequestDto({ ...entry.request, requestId }));
    },
    pendingCount() {
      return pending.size;
    },
    /** @param {(event: ApprovalEvent) => void} listener */
    observe(listener) {
      observers.add(listener);
      return () => { observers.delete(listener); };
    },
    /**
     * An answer from a remote front end (#1194, step 3; §7.4): only *allow
     * once* or *deny* — anything beyond is refused, not quietly made smaller —
     * and on a sandbox card only paths the card offered. Whether the front
     * end may answer for this chat at all, its dispatcher decided.
     *
     * @param {unknown} requestId
     * @param {{ response?: unknown, sandboxPaths?: unknown }} answer
     * @param {ApprovalAnswerer} by
     */
    respondFromRemote(requestId, { response, sandboxPaths } = {}, by) {
      const entry = typeof requestId === 'string' ? pending.get(requestId) : undefined;
      if (!entry || typeof requestId !== 'string') return { ok: false, reason: 'not-found' };
      if (typeof response !== 'string' || !REMOTE_RESPONSES.has(response)) return { ok: false, reason: 'refused' };
      const sandbox = entry.request?.sandbox;
      const offered = isRecord(sandbox) && Array.isArray(sandbox.entries) ? sandbox.entries : null;
      if (sandboxPaths !== undefined) {
        if (!offered || !Array.isArray(sandboxPaths) || sandboxPaths.length > offered.length) return { ok: false, reason: 'refused' };
        if (sandboxPaths.some((chosen, i) => chosen != null && (typeof chosen !== 'string' || !offered[i].allow.includes(chosen)))) {
          return { ok: false, reason: 'refused' };
        }
      }
      const paths = offered && response !== APPROVAL_RESPONSES.DENY
        ? { sandboxPaths: offered.map((e, i) => {
          // Checked above: a chosen path is one the card offered.
          const chosen = Array.isArray(sandboxPaths) ? /** @type {string|null|undefined} */ (sandboxPaths[i]) : null;
          return chosen ?? e.allow[0];
        }) }
        : {};
      settle(requestId, { response: /** @type {import('../../shared/contracts/tool-permissions').ApprovalResponse} */ (response), ...paths }, by);
      return { ok: true, response };
    },
  };
}

module.exports = {
  createToolApprovalAdapter,
};
