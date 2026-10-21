'use strict';

/**
 * Pairing a phone with this desktop (#1114): the decisions of the desktop's
 * half of docs/remote-protocol.md part 1 — phases 1, 3 and 5 of
 * docs/remote-pairing-sequence.svg.
 *
 * - **Open** (steps 3–11): the identity keys, created on first use; a fresh
 *   pairing at the relay; the code to the window; five minutes.
 * - **Confirm** (steps 25–35): the claim's `MAC_P` checked first — a wrong one
 *   cancels at once; then the six words, and the person at the desktop asked
 *   through the user-confirmation port (#980). Only its *Allow* lets the phone
 *   in; *Deny* is the default. On *Allow* the phone's keys are kept, `MAC_D`
 *   goes to the relay, and a phone paired before loses its channel (R1).
 * - **Remove** (phase 5): the phone's keys go here at once, the channel at the
 *   relay as far as it can be reached.
 *
 * Every way a pairing ends that is not *Allow* — cancel, expiry, a wrong MAC,
 * *Deny*, a relay that fails — leaves no channel behind at the relay, as far
 * as the relay can be reached.
 *
 * Nothing here talks to the relay before `start()` or `unpair()` (R7):
 * building the service and reading its state touch only the local store.
 *
 * The pairing code lives here only while it is shown; its secret is
 * forgotten as soon as the pairing ends. Private keys never come here at all —
 * the identity port hands out a signer.
 */

const { CONFIRMATION_ACTIONS, NO_RECEIPTS } = require('../permissions/user-confirmation');
const {
  REMOTE_PAIRING_STATES: STATES,
  REMOTE_PAIRING_REASONS: REASONS,
  normalizeRemotePairingState,
  normalizeRemotePairingResult,
} = require('../../shared/contracts/remote/pairing-state');

/** How long a code is shown before it expires (protocol §5.3). */
const PAIRING_TTL_MS = 5 * 60_000;

/** @type {Set<string>} */
const ACTIVE_STEPS = new Set([STATES.OPENING, STATES.CODE, STATES.CONFIRM]);
const STATE_REASONS = new Set(Object.values(REASONS));

/**
 * A relay's reason as the state names it; one the state does not know is left out.
 * @param {*} error  what the relay port rejected with
 */
function reasonOf(error) {
  const reason = error && typeof error === 'object' ? error.reason : null;
  return STATE_REASONS.has(reason) ? reason : null;
}

/**
 * 404 and 409 from the relay mean the pairing is gone or no longer pending: it ran out.
 * @param {*} error  what the relay port rejected with
 */
function isGone(error) {
  return error?.reason === 'not-found' || error?.reason === 'busy';
}

/**
 * One pairing, from `start()` on: what is shown, what is held back until the
 * phone answers, and whether it is over.
 *
 * @typedef {object} PairingAttempt
 * @property {string} step  a REMOTE_PAIRING_STATES value
 * @property {string|null} reason  a REMOTE_PAIRING_REASONS value, when it ended without *Allow*
 * @property {boolean} done
 * @property {boolean} claimed
 * @property {boolean} finishing
 * @property {string|null} channelId
 * @property {string|null} pairingId
 * @property {string|null} code  the secret, forgotten as soon as the pairing ends
 * @property {string|null} display
 * @property {string|null} qr
 * @property {string[]|null} words
 * @property {number|null} expiresAt
 * @property {import('../ports/remote-relay-port').RemoteKeyBundle|null} desktopKeys
 * @property {import('../ports/remote-relay-port').RemoteSigner|null} sign
 * @property {unknown} timer
 * @property {{ close: () => void }|null} watch
 * @property {AbortController|null} sheet
 */

/**
 * @param {{
 *   relay: import('../ports/remote-relay-port').RemoteRelayPort,
 *   identity: import('../ports/remote-identity-port').RemoteIdentityPort,
 *   crypto: import('../ports/remote-pairing-crypto-port').RemotePairingCryptoPort,
 *   confirmations: import('../ports/user-confirmation-port').UserConfirmationPort,
 *   receipts?: { redeem: (receipt: unknown, action: string, subject?: string) => boolean },
 *   prompt: (input: { words: string[], replacing: boolean }) => import('../ports/user-confirmation-port').ConfirmationPrompt,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 *   log?: { warn: (...args: unknown[]) => void },
 *   connection?: { isConnected: () => boolean },
 *   open?: boolean | (() => boolean),
 * }} deps  `receipts` is the half of the registry that redeems; without it nothing is ever allowed.
 *   `connection` is the channel (#1192): whether a session with the paired phone stands.
 *   `open` false keeps pairing closed (#1110): `start` refuses with `locked` before anything
 *   reaches the relay; cancelling and removing a phone still work. A function is asked each
 *   time — developer mode opens it (#1213); `refresh()` after it changed.
 */
function createRemotePairing({
  relay,
  identity,
  crypto,
  confirmations,
  receipts = NO_RECEIPTS,
  prompt,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(/** @type {any} */ (timer)),
  log = console,
  connection = { isConnected: () => false },
  open = true,
}) {
  const isOpen = typeof open === 'function' ? open : () => open !== false;
  /**
   * The paired phone as kept: { channelId, keys, pairedAt }
   * @type {import('../ports/remote-identity-port').RemotePairedPhone | null}
   */
  let phone = null;
  /** @type {Promise<void> | null} */
  let phoneRead = null;
  /**
   * The pairing running or just ended. Each start makes a new one; every
   * asynchronous step checks that its pairing is still the current one, so a
   * late answer for a cancelled pairing changes nothing.
   *
   * @type {PairingAttempt | null}
   */
  let flow = null;
  /** @type {Set<(state: ReturnType<typeof snapshot>) => void>} */
  const listeners = new Set();

  function loadPhone() {
    phoneRead ??= identity.readPhone().then(
      (stored) => { phone = stored; },
      (error) => { log.warn(`[remote] the paired phone could not be read (${error?.name || 'error'})`); },
    );
    return phoneRead;
  }

  function snapshot() {
    const step = flow ? flow.step : phone ? STATES.PAIRED : STATES.EMPTY;
    return normalizeRemotePairingState({
      state: step,
      encryptionAvailable: identity.isAvailable(),
      phone: phone ? { pairedAt: phone.pairedAt, connected: connection.isConnected() === true } : null,
      code: flow && step === STATES.CODE ? { display: flow.display, qr: flow.qr, expiresAt: flow.expiresAt } : null,
      words: flow && step === STATES.CONFIRM ? flow.words : null,
      replacing: !!flow && ACTIVE_STEPS.has(step) && !!phone,
      reason: flow?.reason ?? null,
      locked: !isOpen(),
    });
  }

  function emit() {
    const state = snapshot();
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        log.warn(`[remote] a state listener failed (${error?.name || 'error'})`);
      }
    }
  }

  /** @param {PairingAttempt} attempt */
  function isCurrent(attempt) {
    return flow === attempt && !attempt.done;
  }

  /**
   * Lets go of everything a pairing holds: timer, stream, an open sheet, the code.
   * @param {PairingAttempt} attempt
   */
  function release(attempt) {
    attempt.done = true;
    attempt.finishing = false;
    if (attempt.timer !== null) clearTimer(attempt.timer);
    attempt.timer = null;
    attempt.watch?.close();
    attempt.watch = null;
    attempt.sheet?.abort();
    attempt.code = null;
    attempt.display = null;
    attempt.qr = null;
    attempt.words = null;
  }

  /**
   * A pairing that ended without *Allow*: its state stays until the next start or cancel.
   *
   * @param {PairingAttempt} attempt
   * @param {string} step
   * @param {string|null} [reason]
   */
  function end(attempt, step, reason = null) {
    release(attempt);
    attempt.step = step;
    attempt.reason = reason;
    emit();
  }

  /**
   * Best effort, never thrown: the outcome for the user is already decided.
   * Started at once, not on a later tick, so that a quit right after still
   * sends it before the adapter closes.
   *
   * @param {string} what
   * @param {() => Promise<void>} run
   */
  function tidy(what, run) {
    let pending;
    try {
      pending = run();
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).catch((error) => log.warn(`[remote] ${what} at the relay failed (${error?.reason || 'error'})`));
  }

  /** @param {PairingAttempt} attempt */
  function cancelAtRelay(attempt) {
    const { channelId, pairingId } = attempt;
    if (channelId && pairingId) tidy('cancelling the pairing', () => relay.cancelPairing(channelId, pairingId));
  }

  /**
   * @param {string} channelId
   * @param {import('../ports/remote-relay-port').RemoteSigner} sign
   */
  function deleteAtRelay(channelId, sign) {
    tidy('deleting the channel', () => relay.deleteChannel(channelId, { sign }));
  }

  /** Stops the current pairing, at the relay as well. False while one is being completed. */
  function stopFlow() {
    if (!flow) return true;
    if (flow.finishing) return false;
    const attempt = flow;
    flow = null;
    if (!attempt.done) {
      release(attempt);
      cancelAtRelay(attempt);
    }
    return true;
  }

  /** @param {PairingAttempt} attempt */
  function expire(attempt) {
    attempt.timer = null;
    if (!isCurrent(attempt) || attempt.finishing) return;
    cancelAtRelay(attempt);
    end(attempt, STATES.EXPIRED);
  }

  /**
   * @param {PairingAttempt} attempt
   * @param {import('../ports/remote-relay-port').RemoteChannelRecord|null} record
   */
  function onRecord(attempt, record) {
    if (!isCurrent(attempt) || attempt.claimed) return;
    if (record === null) {
      // The relay cleaned it up, or the phone gave up before claiming.
      end(attempt, STATES.EXPIRED);
      return;
    }
    if (record.status !== 'pending' || !record.phoneKeys || !record.macP) return;
    attempt.claimed = true;
    void confirmClaim(attempt, record).catch((error) => {
      log.warn(`[remote] the pairing failed (${error?.name || 'error'})`);
      if (!isCurrent(attempt)) return;
      cancelAtRelay(attempt);
      end(attempt, STATES.STOPPED, REASONS.NOT_SAVED);
    });
  }

  /**
   * @param {PairingAttempt} attempt
   * @param {*} error
   */
  function onWatchError(attempt, error) {
    // Once the claim is in, the stream has done its job.
    if (!isCurrent(attempt) || attempt.claimed) return;
    cancelAtRelay(attempt);
    end(attempt, STATES.UNREACHABLE, reasonOf(error) || REASONS.NETWORK);
  }

  /**
   * Steps 25–35: `MAC_P`, the words, the person at the desktop, `MAC_D`.
   * @param {PairingAttempt} attempt
   * @param {import('../ports/remote-relay-port').RemoteChannelRecord} record
   */
  async function confirmClaim(attempt, record) {
    const { code, channelId, desktopKeys, sign } = attempt;
    const { phoneKeys, macP } = record;
    // A claim arrives only through the stream `start()` opens after it filled these in.
    if (code === null || channelId === null || desktopKeys === null || sign === null) {
      throw new Error('a claim arrived before the pairing was open');
    }
    if (!phoneKeys || !macP || !crypto.isKeyBundle(phoneKeys)
      || !crypto.verifyPhoneMac({ code, channelId, desktopKeys, phoneKeys, macP })) {
      // Keys that are not the ones the person with the code sent (§6).
      cancelAtRelay(attempt);
      end(attempt, STATES.STOPPED, REASONS.MAC);
      return;
    }
    const claim = { code, channelId, desktopKeys, phoneKeys };
    const replacing = !!phone;
    const words = crypto.phrase(desktopKeys, phoneKeys);
    attempt.words = words;
    attempt.step = STATES.CONFIRM;
    attempt.sheet = new AbortController();
    attempt.watch?.close();
    attempt.watch = null;
    emit();

    /** @type {import('../ports/user-confirmation-port').ConfirmationOutcome} */
    let outcome;
    try {
      outcome = await confirmations.confirm({
        action: CONFIRMATION_ACTIONS.REMOTE_PAIRING,
        subject: channelId,
        prompt: prompt({ words, replacing }),
        signal: attempt.sheet.signal,
      });
    } catch (error) {
      log.warn(`[remote] the confirmation could not be shown (${error?.name || 'error'})`);
      outcome = { confirmed: false };
    }
    // Cancelled, expired or replaced while the sheet was open: that path tidied up.
    if (!isCurrent(attempt)) return;
    const allowed = outcome?.confirmed === true
      && receipts.redeem(outcome.receipt, CONFIRMATION_ACTIONS.REMOTE_PAIRING, channelId);
    if (!allowed) {
      deleteAtRelay(channelId, sign);
      end(attempt, STATES.DENIED);
      return;
    }

    // From here on the pairing completes or fails; it is not cancelled any more.
    attempt.finishing = true;
    if (attempt.timer !== null) clearTimer(attempt.timer);
    attempt.timer = null;
    const macD = crypto.desktopMac(claim);
    try {
      await relay.confirmPairing(channelId, macD);
    } catch (error) {
      deleteAtRelay(channelId, sign);
      end(attempt, isGone(error) ? STATES.EXPIRED : STATES.UNREACHABLE, isGone(error) ? null : reasonOf(error) || REASONS.NETWORK);
      return;
    }

    const previous = phone;
    const next = { channelId, keys: { ...phoneKeys }, pairedAt: now() };
    try {
      await identity.savePhone(next);
    } catch (error) {
      log.warn(`[remote] the phone's keys could not be kept (${error?.name || 'error'})`);
      deleteAtRelay(channelId, sign);
      end(attempt, STATES.STOPPED, REASONS.NOT_SAVED);
      return;
    }
    phone = next;
    // R1: one phone per computer. The old one keeps its access until now.
    if (previous && previous.channelId !== next.channelId) deleteAtRelay(previous.channelId, sign);
    release(attempt);
    flow = null;
    emit();
  }

  /** Steps 3–11. A running pairing is stopped first; a phone paired already stays until *Allow*. */
  async function start() {
    // Not open yet (#1110): refused here, whatever the window shows — nothing reaches the relay.
    if (!isOpen()) return normalizeRemotePairingResult({ ok: false, reason: REASONS.LOCKED });
    if (!identity.isAvailable()) return normalizeRemotePairingResult({ ok: false, reason: REASONS.ENCRYPTION_UNAVAILABLE });
    if (!stopFlow()) return normalizeRemotePairingResult({ ok: false, reason: REASONS.BUSY });

    // Registered before the first await, so that a cancel right after counts.
    /** @type {PairingAttempt} */
    const attempt = {
      step: STATES.OPENING,
      reason: null,
      done: false,
      claimed: false,
      finishing: false,
      channelId: null,
      pairingId: null,
      code: null,
      display: null,
      qr: null,
      words: null,
      expiresAt: null,
      desktopKeys: null,
      sign: null,
      timer: null,
      watch: null,
      sheet: null,
    };
    flow = attempt;
    await loadPhone();
    if (!isCurrent(attempt)) return normalizeRemotePairingResult({ ok: false, reason: REASONS.CANCELLED });
    emit();

    let keys;
    try {
      keys = await identity.loadIdentity();
    } catch (error) {
      log.warn(`[remote] the identity keys could not be kept (${error?.name || 'error'})`);
      if (isCurrent(attempt)) end(attempt, STATES.STOPPED, REASONS.NOT_SAVED);
      return normalizeRemotePairingResult({ ok: false, reason: REASONS.NOT_SAVED });
    }
    if (!isCurrent(attempt)) return normalizeRemotePairingResult({ ok: false, reason: REASONS.CANCELLED });

    let opened;
    try {
      opened = await relay.openPairing({ desktopKeys: keys.keys, sign: keys.sign });
    } catch (error) {
      const reason = reasonOf(error) || REASONS.NETWORK;
      if (isCurrent(attempt)) end(attempt, STATES.UNREACHABLE, reason);
      return normalizeRemotePairingResult({ ok: false, reason });
    }
    if (!isCurrent(attempt)) {
      // Cancelled while the relay was asked: the pairing it opened goes again.
      tidy('cancelling the pairing', () => relay.cancelPairing(opened.channelId, opened.pairingId));
      return normalizeRemotePairingResult({ ok: false, reason: REASONS.CANCELLED });
    }

    let code;
    try {
      code = crypto.createCode(opened.pairingId, opened.relayHost);
    } catch {
      // A pairing id that is not four symbols is no answer of the protocol's.
      tidy('cancelling the pairing', () => relay.cancelPairing(opened.channelId, opened.pairingId));
      end(attempt, STATES.UNREACHABLE, REASONS.INVALID_RESPONSE);
      return normalizeRemotePairingResult({ ok: false, reason: REASONS.INVALID_RESPONSE });
    }
    Object.assign(attempt, {
      step: STATES.CODE,
      channelId: opened.channelId,
      pairingId: opened.pairingId,
      code: code.code,
      display: code.display,
      qr: code.qr,
      desktopKeys: keys.keys,
      sign: keys.sign,
      // The local clock: the relay's may differ, and the five minutes are the protocol's.
      expiresAt: now() + PAIRING_TTL_MS,
    });
    attempt.timer = setTimer(() => expire(attempt), PAIRING_TTL_MS);
    attempt.watch = relay.watchChannel(opened.channelId, {
      onRecord: (record) => onRecord(attempt, record),
      onError: (error) => onWatchError(attempt, error),
    });
    emit();
    return normalizeRemotePairingResult({ ok: true });
  }

  /** *Cancel*, or leaving an ended pairing's state. */
  async function cancel() {
    await loadPhone();
    if (!stopFlow()) return normalizeRemotePairingResult({ ok: false, reason: REASONS.BUSY });
    emit();
    return normalizeRemotePairingResult({ ok: true });
  }

  /**
   * *Remove phone*: here at once, whatever the relay says — the phone's keys
   * are gone, so this desktop no longer answers it. Then the channel at the
   * relay, so that the phone learns it.
   */
  async function unpair() {
    await loadPhone();
    if (!stopFlow()) return normalizeRemotePairingResult({ ok: false, reason: REASONS.BUSY });
    const removed = phone;
    if (!removed) {
      emit();
      return normalizeRemotePairingResult({ ok: true });
    }
    try {
      await identity.forgetPhone();
    } catch (error) {
      log.warn(`[remote] the phone could not be forgotten (${error?.name || 'error'})`);
      emit();
      return normalizeRemotePairingResult({ ok: false, reason: REASONS.NOT_SAVED });
    }
    phone = null;
    emit();
    let relayDeleted = true;
    try {
      const keys = await identity.loadIdentity();
      await relay.deleteChannel(removed.channelId, { sign: keys.sign });
    } catch (error) {
      // Gone already is what was wanted.
      relayDeleted = error?.reason === 'not-found';
      if (!relayDeleted) log.warn(`[remote] deleting the channel at the relay failed (${reasonOf(error) || 'error'})`);
    }
    return normalizeRemotePairingResult({ ok: true, relayDeleted });
  }

  /**
   * The relay removed the channel of the paired phone (#1192, protocol §12.2) —
   * the phone disconnected itself: forgotten here as well. A pairing running
   * meanwhile goes on; it replaces a phone that is gone already.
   *
   * @param {string} channelId
   */
  async function forgetChannel(channelId) {
    await loadPhone();
    if (!phone || phone.channelId !== channelId) return;
    try {
      await identity.forgetPhone();
    } catch (error) {
      log.warn(`[remote] the phone could not be forgotten (${error?.name || 'error'})`);
      return;
    }
    if (phone?.channelId !== channelId) return;
    phone = null;
    emit();
  }

  async function getState() {
    await loadPhone();
    return snapshot();
  }

  /** @param {(state: ReturnType<typeof normalizeRemotePairingState>) => void} listener */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** At quit: a pairing still running is cancelled, the streams close. */
  function dispose() {
    stopFlow();
    listeners.clear();
    relay.close();
  }

  /**
   * Whether pairing is open changed (#1213): the state says so, and a pairing
   * under way while it closed stops — one past *Allow* is let finish.
   */
  function refresh() {
    if (!isOpen() && flow && !flow.done) stopFlow();
    emit();
  }

  return { start, cancel, unpair, forgetChannel, getState, subscribe, dispose, notifyConnection: emit, refresh };
}

module.exports = { createRemotePairing, PAIRING_TTL_MS };
