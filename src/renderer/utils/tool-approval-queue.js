/**
 * Offene Freigabe-Anfragen im Renderer (Issue #67, Konzept §6).
 *
 * Hält je `requestId` genau einen Eintrag und schützt die Karte vor den
 * Fehlerfällen, die keine Wirkung haben dürfen: doppelte Anfragen, doppelte
 * Klicks, verspätete oder unbekannte Auflösungen. Die eigentliche
 * Entscheidung trifft der Main-Prozess; hier wird nur verfolgt, was der
 * Nutzer sieht und schon beantwortet hat. Bewusst ohne DOM (node:test).
 */
import contracts from '../generated/contracts.js';

const { isToolApprovalRequestDto, normalizeApprovalResponse } = contracts;

export const APPROVAL_ENTRY_STATES = Object.freeze({
  PENDING: 'pending',
  RESPONDING: 'responding',
  RESOLVED: 'resolved',
});

export function createToolApprovalQueue() {
  /** requestId → { dto, state, response, outcome } */
  const entries = new Map();

  return {
    /** Neue Anfrage; ungültige DTOs und Duplikate werden ignoriert (null). */
    add(dto) {
      if (!isToolApprovalRequestDto(dto)) return null;
      if (entries.has(dto.requestId)) return null;
      const entry = { dto, state: APPROVAL_ENTRY_STATES.PENDING, response: null, outcome: null };
      entries.set(dto.requestId, entry);
      return entry;
    },
    get(requestId) {
      return entries.get(requestId) || null;
    },
    has(requestId) {
      return entries.has(requestId);
    },
    pending() {
      return [...entries.values()].filter((entry) => entry.state === APPROVAL_ENTRY_STATES.PENDING);
    },
    /** Erster Klick gewinnt: weitere Antworten auf dieselbe Anfrage tun nichts. */
    beginResponse(requestId, response) {
      const entry = entries.get(requestId);
      const normalized = normalizeApprovalResponse(response);
      if (!entry || !normalized || entry.state !== APPROVAL_ENTRY_STATES.PENDING) return false;
      entry.state = APPROVAL_ENTRY_STATES.RESPONDING;
      entry.response = normalized;
      return true;
    },
    /** IPC-Antwort fehlgeschlagen: Karte wieder bedienbar, sofern nicht inzwischen aufgelöst. */
    failResponse(requestId) {
      const entry = entries.get(requestId);
      if (!entry || entry.state !== APPROVAL_ENTRY_STATES.RESPONDING) return false;
      entry.state = APPROVAL_ENTRY_STATES.PENDING;
      entry.response = null;
      return true;
    },
    /**
     * Auflösung durch den Main (Antwort angenommen oder verfallen). Unbekannte
     * oder bereits aufgelöste Anfragen liefern null – sie dürfen nichts auslösen.
     */
    resolve(payload) {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
      const entry = entries.get(requestId);
      if (!entry || entry.state === APPROVAL_ENTRY_STATES.RESOLVED) return null;
      entry.state = APPROVAL_ENTRY_STATES.RESOLVED;
      entry.outcome = {
        invalidated: payload.invalidated === true,
        response: payload.invalidated === true ? null : normalizeApprovalResponse(payload.response),
        reason: typeof payload.reason === 'string' ? payload.reason : null,
      };
      return entry;
    },
    /** Drops entries outright, whatever their state — a chat that was left (#320). */
    forgetWhere(predicate) {
      const out = [];
      for (const [requestId, entry] of [...entries.entries()]) {
        if (!predicate(entry)) continue;
        entries.delete(requestId);
        out.push(entry);
      }
      return out;
    },
    size() {
      return entries.size;
    },
  };
}
