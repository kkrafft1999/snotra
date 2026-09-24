'use strict';

/**
 * Approval-Port-Adapter (Issue #66, Konzept §6): Freigabe-Karten über IPC.
 *
 * Der Renderer meldet sich pro Fenster (webContents) als freigabefähig an.
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
} = require('../../shared/contracts/tool-permissions');
const { createMessage } = require('../../shared/contracts/message');

function chatKey(chatId) {
  return typeof chatId === 'string' && chatId ? chatId : null;
}

function createToolApprovalAdapter({ randomUUID, PUSH, log = console }) {
  /** sessionId → webContents (nur angemeldete Fenster). */
  const subscribers = new Map();
  /** requestId → { sessionId, chatId, resolve, request, cleanup } */
  const pending = new Map();

  function send(webContents, channel, payload) {
    if (!webContents || typeof webContents.send !== 'function') return false;
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return false;
    try {
      webContents.send(channel, payload);
      return true;
    } catch (error) {
      log?.warn?.(`[tool-approval] Senden fehlgeschlagen: ${error?.message || error}`);
      return false;
    }
  }

  function settle(requestId, outcome) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    entry.cleanup?.();
    const webContents = subscribers.get(entry.sessionId);
    if (webContents) {
      send(webContents, PUSH.TOOL_APPROVAL_RESOLVED, {
        requestId,
        response: outcome.invalidated ? null : outcome.response,
        invalidated: outcome.invalidated === true,
        reason: outcome.reason || null,
      });
    }
    entry.resolve({ ...outcome, requestId });
    return true;
  }

  function invalidateSession(sessionId, reason = PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED) {
    for (const [requestId, entry] of [...pending.entries()]) {
      if (entry.sessionId === sessionId) settle(requestId, { invalidated: true, reason });
    }
  }

  function invalidateAll(reason = PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED) {
    for (const requestId of [...pending.keys()]) settle(requestId, { invalidated: true, reason });
  }

  /** Open requests of one chat only — its mode changed, or it was deleted (#320). */
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
   */
  function invalidateExceptChats(chatIds, reason = PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED) {
    const keep = new Set([...chatIds].map(chatKey));
    for (const [requestId, entry] of [...pending.entries()]) {
      if (!keep.has(entry.chatId)) settle(requestId, { invalidated: true, reason });
    }
  }

  return {
    /** Renderer meldet sich als freigabefähig an; bei Zerstörung wieder ab. */
    subscribe(sessionId, webContents) {
      if (!webContents) return false;
      subscribers.set(sessionId, webContents);
      if (typeof webContents.once === 'function') {
        webContents.once('destroyed', () => {
          if (subscribers.get(sessionId) === webContents) subscribers.delete(sessionId);
          invalidateSession(sessionId, PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
        });
      }
      return true;
    },
    unsubscribe(sessionId) {
      subscribers.delete(sessionId);
      invalidateSession(sessionId, PERMISSION_DENIAL_REASONS.NO_APPROVAL_UI);
    },
    isAvailable(sessionId) {
      const webContents = subscribers.get(sessionId);
      if (!webContents) return false;
      if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
        subscribers.delete(sessionId);
        return false;
      }
      return true;
    },
    /**
     * @returns {Promise<{ response?: string, invalidated?: boolean, reason?: string, requestId: string }>}
     */
    requestApproval({ sessionId, request, abortSignal }) {
      const webContents = subscribers.get(sessionId);
      if (!this.isAvailable(sessionId)) {
        return Promise.resolve({ invalidated: true, reason: PERMISSION_DENIAL_REASONS.NO_APPROVAL_UI, requestId: '' });
      }
      if (abortSignal?.aborted) {
        return Promise.resolve({ invalidated: true, reason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED, requestId: '' });
      }
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const onAbort = () => settle(requestId, { invalidated: true, reason: PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED });
        abortSignal?.addEventListener?.('abort', onAbort, { once: true });
        pending.set(requestId, {
          sessionId,
          chatId: chatKey(request?.chatId),
          request,
          resolve,
          cleanup: () => abortSignal?.removeEventListener?.('abort', onAbort),
        });
        const dto = createToolApprovalRequestDto({ ...request, requestId });
        if (!send(webContents, PUSH.TOOL_APPROVAL_REQUEST, dto)) {
          settle(requestId, { invalidated: true, reason: PERMISSION_DENIAL_REASONS.NO_APPROVAL_UI });
        }
      });
    },
    /**
     * Antwort aus dem Renderer. Akzeptiert nur eine Entscheidung auf eine
     * eigene, offene Anfrage; alles andere ist ein Fehler ohne Wirkung.
     */
    respond(sessionId, { requestId, response } = {}) {
      const entry = pending.get(requestId);
      if (!entry) return { ok: false, error: createMessage('approval.error.noPending') };
      if (entry.sessionId !== sessionId) return { ok: false, error: createMessage('approval.error.otherWindow') };
      if (!Object.values(APPROVAL_RESPONSES).includes(response)) {
        return { ok: false, error: createMessage('approval.error.invalidResponse') };
      }
      if (response === APPROVAL_RESPONSES.ALLOW_SESSION && entry.request?.sessionAllowed !== true) {
        // Die Karte bot die Option nicht an; als Einzelfreigabe behandeln.
        settle(requestId, { response: APPROVAL_RESPONSES.ALLOW_ONCE });
        return { ok: true, response: APPROVAL_RESPONSES.ALLOW_ONCE };
      }
      settle(requestId, { response });
      return { ok: true, response };
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
  };
}

module.exports = {
  createToolApprovalAdapter,
};
