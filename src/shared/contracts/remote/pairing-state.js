/**
 * What *Settings › Remote access* (#1110) learns from main about pairing a
 * phone (#1114): one state, pushed on every change and read when the panel
 * opens, and the few facts the panel draws it from.
 *
 * The normalizer is the gate on the way out of main: whatever the bridge
 * holds — identity keys, relay tokens, the phone's keys, the channel id —
 * only the fields below cross to the window, each checked for its shape. The
 * pairing code is the one secret that does cross, on purpose and only while
 * it is shown: the QR code and the typed key are how it reaches the phone
 * (docs/remote-protocol.md §4).
 */
'use strict';

/**
 * The panel's eleven states (#1110) as main tells them. Main owns nine of
 * them; *Replace phone?* (6) and *Remove phone?* (7) are questions the panel
 * asks itself while main stays in `paired`. *Paired, connected* (4) and
 * *Paired, phone offline* (5) are both `paired`, told apart by
 * `phone.connected` — true while a session of the channel stands, from the
 * phone's `session.hello` on (#1192).
 */
const REMOTE_PAIRING_STATES = Object.freeze({
  /** 1 — no phone paired and no pairing running. Nothing has reached the relay (R7). */
  EMPTY: 'empty',
  /** 2, before the code exists — the relay is being asked for a pairing. */
  OPENING: 'opening',
  /** 2 — the QR code and the typed key, valid until `code.expiresAt`. */
  CODE: 'code',
  /** 3 — a phone answered with the right `MAC_P`; the six words, and the native sheet over the window. */
  CONFIRM: 'confirm',
  /** 4 and 5 — a phone is paired. */
  PAIRED: 'paired',
  /** 8 — no claim within five minutes, or the relay cleaned the pairing up. */
  EXPIRED: 'expired',
  /** 9 — the claim's `MAC_P` was wrong (`reason: 'mac'`), or the phone's keys could not be kept (`'not-saved'`). */
  STOPPED: 'stopped',
  /** 10 — the relay could not be reached or refused; `reason` says how. */
  UNREACHABLE: 'unreachable',
  /** 11 — *Deny* in the native sheet, or no person at the desktop to ask. */
  DENIED: 'denied',
});

/** Why a pairing ended in `unreachable` or `stopped`, or why an action was refused. */
const REMOTE_PAIRING_REASONS = Object.freeze({
  /** No answer: offline, a timeout, a stream that kept failing. */
  NETWORK: 'network',
  /** No relay is configured in this build (until phase 2 of #1081 sets one). */
  NOT_CONFIGURED: 'not-configured',
  UNAUTHORIZED: 'unauthorized',
  REFUSED: 'refused',
  RATE_LIMITED: 'rate-limited',
  UNAVAILABLE: 'unavailable',
  /** The relay answered with something that is not the protocol. */
  INVALID_RESPONSE: 'invalid-response',
  /** The claim's `MAC_P` did not verify, or its keys were no P-256 points. */
  MAC: 'mac',
  /** The identity keys or the phone's keys could not be written. */
  NOT_SAVED: 'not-saved',
  /** `safeStorage` has no real encryption here, so no key may be kept (#1012). */
  ENCRYPTION_UNAVAILABLE: 'encryption-unavailable',
  /** A pairing is being completed after *Allow*; it cannot be cancelled or replaced any more. */
  BUSY: 'busy',
  /** The pairing was cancelled while it was being opened. */
  CANCELLED: 'cancelled',
  /** Pairing is not open in this build yet: the phone's side comes first (#1110, decided 2026-10-21). */
  LOCKED: 'locked',
});

const STATE_VALUES = new Set(Object.values(REMOTE_PAIRING_STATES));
const REASON_VALUES = new Set(Object.values(REMOTE_PAIRING_REASONS));

/** `0111-EP9D-ZH4Q-PYT4-HWWF`: twenty symbols of Crockford's base32, in groups of four. */
const DISPLAY_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){4}$/;
/** `snotra-pair:v1/<relay host>/<twenty symbols>` (protocol §4). */
const QR_PAYLOAD = /^snotra-pair:v1\/[a-z0-9.-]+(?::\d{1,5})?\/[0-9A-HJKMNP-TV-Z]{20}$/;
/** A word of the EFF short word list 2.0: lower case, 3 to 10 letters, one of them with a hyphen. */
const SAFETY_WORD = /^[a-z][a-z-]{1,9}[a-z]$/;
const PHRASE_WORDS = 6;
/** A QR code's sides, from version 1 (21 modules) to version 40 (177). */
const QR_MIN = 21;
const QR_MAX = 177;
const QR_ROW = /^[01]+$/;

/** @param {unknown} value */
function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * The QR code's modules, row by row as `0` and `1` (#1110): main draws the
 * code, the window only paints it. Null for anything that is no square of
 * a QR code's size.
 * @param {unknown} modules
 */
function normalizeModules(modules) {
  if (!Array.isArray(modules) || modules.length < QR_MIN || modules.length > QR_MAX || (modules.length - QR_MIN) % 4 !== 0) return null;
  return modules.every((row) => typeof row === 'string' && row.length === modules.length && QR_ROW.test(row)) ? [...modules] : null;
}

/** @param {*} code */
function normalizeCode(code) {
  if (!code || typeof code !== 'object') return null;
  const expiresAt = finiteTime(code.expiresAt);
  if (typeof code.display !== 'string' || !DISPLAY_CODE.test(code.display)) return null;
  if (typeof code.qr !== 'string' || !QR_PAYLOAD.test(code.qr) || expiresAt === null) return null;
  const modules = normalizeModules(code.modules);
  return { display: code.display, qr: code.qr, expiresAt, ...(modules ? { modules } : {}) };
}

/** @param {*} words */
function normalizeWords(words) {
  if (!Array.isArray(words) || words.length !== PHRASE_WORDS) return null;
  return words.every((word) => typeof word === 'string' && SAFETY_WORD.test(word)) ? [...words] : null;
}

/** @param {*} phone */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'object') return null;
  const connected = phone.connected === true;
  // When a phone that is away was last there (#1233); a connected one needs none.
  return { pairedAt: finiteTime(phone.pairedAt), connected, lastSeen: connected ? null : finiteTime(phone.lastSeen) };
}

/**
 * The state as it may cross to the window. Anything unknown falls back to
 * `empty`; a code outside `code`, words outside `confirm`, are dropped.
 *
 * @param {unknown} input
 * @returns {{
 *   state: string,
 *   encryptionAvailable: boolean,
 *   phone: { pairedAt: number|null, connected: boolean, lastSeen: number|null } | null,
 *   code: { display: string, qr: string, expiresAt: number, modules?: string[] } | null,
 *   words: string[] | null,
 *   replacing: boolean,
 *   reason: string | null,
 *   locked: boolean,
 * }}  `locked`: pairing is not open in this build yet (#1110); removing a phone still is
 */
function normalizeRemotePairingState(input) {
  const raw = input && typeof input === 'object' ? /** @type {Record<string, any>} */ (input) : {};
  const state = STATE_VALUES.has(raw.state) ? raw.state : REMOTE_PAIRING_STATES.EMPTY;
  const code = state === REMOTE_PAIRING_STATES.CODE ? normalizeCode(raw.code) : null;
  const words = state === REMOTE_PAIRING_STATES.CONFIRM ? normalizeWords(raw.words) : null;
  return {
    state: state === REMOTE_PAIRING_STATES.CODE && !code ? REMOTE_PAIRING_STATES.OPENING : state,
    encryptionAvailable: raw.encryptionAvailable === true,
    phone: normalizePhone(raw.phone),
    code,
    words,
    replacing: raw.replacing === true,
    reason: REASON_VALUES.has(raw.reason) ? raw.reason : null,
    locked: raw.locked === true,
  };
}

/**
 * The answer to start, cancel and unpair: whether it was done, and if not,
 * why. `relayDeleted` tells, after *Remove phone*, whether the relay deleted
 * the channel too — the phone is removed here either way.
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, reason?: string, relayDeleted?: boolean }}
 */
function normalizeRemotePairingResult(input) {
  const raw = input && typeof input === 'object' ? /** @type {Record<string, any>} */ (input) : {};
  /** @type {{ ok: boolean, reason?: string, relayDeleted?: boolean }} */
  const result = { ok: raw.ok === true };
  if (REASON_VALUES.has(raw.reason)) result.reason = raw.reason;
  if (typeof raw.relayDeleted === 'boolean') result.relayDeleted = raw.relayDeleted;
  return result;
}

module.exports = {
  REMOTE_PAIRING_STATES,
  REMOTE_PAIRING_REASONS,
  normalizeRemotePairingState,
  normalizeRemotePairingResult,
};
