'use strict';

/**
 * The channel to the paired phone (#1192): the decisions of the desktop's
 * half of docs/remote/remote-protocol.md part 2.
 *
 * - **Connecting** (§12): for a paired phone, on start and again after every
 *   failure, with a growing pause. The relay port fetches and renews the
 *   token and follows the four nodes; a `meta` that vanishes ends the channel
 *   for good, whatever the other streams still show, and the phone is
 *   forgotten through `onGone`.
 * - **Presence** (§12.3): `presence/desktop` written every 30 seconds while
 *   the streams stand, deleted when the channel stops. The phone counts as
 *   present while its heartbeat is at most 90 seconds old — looked at again as
 *   it ages, not only when it changes (#1227) — and is never taken for a
 *   connection. Listeners hear of both, for the window's indicator (#1196),
 *   and, while the phone is away, when it was last there (#1233): its last
 *   heartbeat, or the moment it took its record away (§12.3, the app going
 *   to the background). A link the desktop loses itself is not the phone
 *   leaving; another phone starts from nothing.
 * - **Handshake** (§13, §14): every new handshake 1 is answered — with a fresh
 *   ephemeral key and the highest common version, or `protocol-unsupported` —
 *   and ends the session before it.
 * - **Envelopes** (§15, §16): the receive rules to the letter, each envelope
 *   deleted once handled; a session ends after 24 hours or 2³² envelopes.
 * - **The first message** (§17): `session.hello` mints the connection, and
 *   only then does the phone count as connected. Everything after it goes to
 *   the message-layer port (#1194, a stand-in until then).
 *
 * Nothing here reads a key: the identity port agrees and signs, the crypto
 * port keeps the session keys. Nothing logged names a channel, a session or
 * what a message said.
 */

const { remoteRpcError } = require('../../shared/contracts/remote/rpc-errors');
const { DEFAULT_LOCALE, LOCALES } = require('../../shared/i18n/locales');

/** The versions of the protocol this desktop speaks (§1, §13). */
const SPOKEN_VERSIONS = Object.freeze([1]);
/** How far ahead of the next expected counter an envelope is held (§16). */
const HOLD_WINDOW = 32;
/** How long a gap may stay open before the session starts over (§16). */
const HOLD_MS = 5_000;
/** A session's longest life, and its most envelopes per direction (§15). */
const SESSION_MAX_MS = 24 * 60 * 60_000;
const SESSION_MAX_ENVELOPES = 2 ** 32;
/** One envelope, one message, at most this much UTF-8 (§15). */
const MAX_MESSAGE_BYTES = 256 * 1024;
/** The desktop's heartbeat (§12.3). */
const PRESENCE_INTERVAL_MS = 30_000;
/** The phone counts as gone once its last heartbeat is older than this (§12.3). */
const PHONE_PRESENCE_TIMEOUT_MS = 90_000;
/** The pause before connecting again: doubling from the first, up to the last. */
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** After a refusal the relay is not asked again soon. */
const RECONNECT_REFUSED_MS = 5 * 60_000;
const TRANSIENT = new Set(['network', 'unavailable', 'rate-limited']);

const CLIENT_NAME_MAX = 64;
const CLIENT_VERSION_MAX = 32;
const REQUEST_ID_MAX = 64;
const KNOWN_LOCALES = new Set(LOCALES);
const CAPABILITIES = new Set(['approvals']);

const encoder = new TextEncoder();

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A request id of the profile (remote-interface.md §6.1): a short string or an integer.
 * @param {unknown} id
 * @returns {id is string|number}
 */
function isRequestId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= REQUEST_ID_MAX) || Number.isSafeInteger(id);
}

/**
 * `session.hello`'s params (remote-interface.md §8.1), or null when they are not.
 * @param {unknown} params
 */
function helloParams(params) {
  if (!isRecord(params)) return null;
  const { protocol, client, locale, capabilities } = params;
  if (!Array.isArray(protocol) || protocol.length === 0 || protocol.length > 16
    || !protocol.every((v) => Number.isInteger(v) && v >= 1 && v <= 255)) return null;
  if (!isRecord(client) || typeof client.name !== 'string' || typeof client.version !== 'string'
    || client.name.length === 0 || client.name.length > CLIENT_NAME_MAX || client.version.length > CLIENT_VERSION_MAX) return null;
  if (locale !== undefined && !KNOWN_LOCALES.has(/** @type {string} */ (locale))) return null;
  if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.length > 16)) return null;
  return {
    protocol: /** @type {number[]} */ (protocol),
    client: { name: client.name, version: client.version },
    locale: /** @type {string} */ (locale ?? DEFAULT_LOCALE),
    capabilities: [...new Set((capabilities ?? []).filter((c) => CAPABILITIES.has(c)))],
  };
}

/**
 * @typedef {Object} Session
 * @property {import('../ports/remote-channel-crypto-port').RemoteChannelSession} keys
 * @property {string} sid
 * @property {number} next  the counter expected from the phone
 * @property {number} out  the counter of the next envelope to the phone
 * @property {Map<number, string>} held  plaintexts that arrived ahead of `next`
 * @property {unknown} holdTimer
 * @property {unknown} lifeTimer
 * @property {import('../ports/remote-message-layer-port').RemoteConnection | null} connection
 * @property {Promise<void>} writes  envelopes go out one after the other
 * @property {boolean} ended
 */

/**
 * What the channel's listeners are told (#1196).
 * @typedef {Object} ChannelState
 * @property {boolean} connected  a session stands (§17)
 * @property {boolean} phonePresent  the phone's heartbeat is fresh (§12.3)
 * @property {number|null} phoneLastSeen  while it is not: when the phone was last there, on
 *   this machine's clock; `null` while it is, or while nothing is known (#1233)
 */

/**
 * @param {{
 *   relay: import('../ports/remote-relay-port').RemoteRelayPort,
 *   identity: import('../ports/remote-identity-port').RemoteIdentityPort,
 *   crypto: import('../ports/remote-channel-crypto-port').RemoteChannelCryptoPort,
 *   messages: import('../ports/remote-message-layer-port').RemoteMessageLayerPort,
 *   word: (locale: string, message: import('../../shared/contracts/message').Message) => string,
 *   appVersion: () => string,
 *   newConnectionId: () => string,
 *   onGone?: (channelId: string) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `onGone` learns that the relay removed the channel, so that the phone can be forgotten
 */
function createRemoteChannel({
  relay,
  identity,
  crypto,
  messages,
  word,
  appVersion,
  newConnectionId,
  onGone = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(/** @type {any} */ (timer)),
  log = console,
}) {
  /** @type {import('../ports/remote-identity-port').RemotePairedPhone | null} */
  let phone = null;
  /** @type {import('../ports/remote-identity-port').RemoteIdentity | null} */
  let own = null;
  /** @type {import('../ports/remote-relay-port').RemoteChannelLink | null} */
  let link = null;
  let live = false;
  /** The phone's last heartbeat on this machine's clock, `null` without a record (§12.3). */
  let phoneLastSeen = /** @type {number|null} */ (null);
  let phoneOnline = false;
  /** When the phone was last there, kept after its record went (#1233); `null` for a phone not seen yet. */
  let phoneLastHere = /** @type {number|null} */ (null);
  /** @type {unknown} */
  let phoneStaleTimer = null;
  /** @type {Session | null} */
  let session = null;
  /** The ephemeral key of the handshake 1 answered last: a stream that reconnects sends it again. */
  let answeredE = /** @type {string|null} */ (null);
  let failures = 0;
  /** @type {unknown} */
  let reconnectTimer = null;
  /** @type {unknown} */
  let presenceTimer = null;
  let disposed = false;
  let warnedNotConfigured = false;
  /** Each change of the phone followed makes a new generation; an answer for an older one changes nothing. */
  let generation = 0;
  /** The same for reading the paired phone. */
  let reads = 0;
  /** @type {Set<(state: ChannelState) => void>} */
  const listeners = new Set();
  /** @type {ChannelState} */
  let lastState = { connected: false, phonePresent: false, phoneLastSeen: null };

  const connected = () => !!session?.connection;

  /**
   * Tells the listeners, once per change: a session that stands or ends, a
   * heartbeat that comes or goes stale, a phone away that was seen at another
   * time. The heartbeats of a phone that is there change nothing.
   */
  function emit() {
    const state = { connected: connected(), phonePresent: phoneOnline, phoneLastSeen: phoneOnline ? null : phoneLastHere };
    if (state.connected === lastState.connected && state.phonePresent === lastState.phonePresent
      && state.phoneLastSeen === lastState.phoneLastSeen) return;
    lastState = state;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        log.warn(`[remote] a channel listener failed (${error?.name || 'error'})`);
      }
    }
  }

  /**
   * Best effort, never thrown: started at once, so that a quit right after still sends it.
   * @param {string} what
   * @param {() => Promise<unknown>} run
   */
  function tidy(what, run) {
    let pending;
    try {
      pending = run();
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).catch((error) => log.warn(`[remote] ${what} failed (${error?.reason || error?.name || 'error'})`));
  }

  // ---------------------------------------------------------------- sessions

  /**
   * @param {Session} s
   * @param {string} reason
   */
  function endSession(s, reason) {
    if (s.ended) return;
    s.ended = true;
    if (s.holdTimer !== null) clearTimer(s.holdTimer);
    if (s.lifeTimer !== null) clearTimer(s.lifeTimer);
    s.holdTimer = null;
    s.lifeTimer = null;
    s.held.clear();
    s.keys.forget();
    const wasConnected = !!s.connection;
    if (s.connection) {
      const { connection } = s;
      s.connection = null;
      try {
        messages.close(connection, reason);
      } catch (error) {
        log.warn(`[remote] closing a connection failed (${error?.name || 'error'})`);
      }
    }
    if (session === s) session = null;
    if (wasConnected) emit();
  }

  /**
   * One JSON-RPC message into the session's outbox (§15, §17).
   * @param {Session} s
   * @param {object} message
   */
  function send(s, message) {
    if (s.ended || session !== s || !link) return false;
    let text = JSON.stringify(message);
    if (encoder.encode(text).length > MAX_MESSAGE_BYTES) {
      // A larger answer is paged by its method, never split (§15).
      const id = /** @type {{ id?: unknown }} */ (message).id;
      if (!isRequestId(id)) {
        log.warn('[remote] an event over the envelope limit was dropped');
        return false;
      }
      text = JSON.stringify(rpcError(s, id, 'too-large'));
    }
    if (s.out >= SESSION_MAX_ENVELOPES) {
      endSession(s, 'limit');
      return false;
    }
    const counter = s.out;
    s.out += 1;
    const sealed = s.keys.seal(counter, text);
    const target = link;
    s.writes = s.writes
      .then(() => target.writeEnvelope(s.sid, counter, sealed))
      .catch((error) => log.warn(`[remote] an envelope could not be written (${error?.reason || error?.name || 'error'})`));
    return true;
  }

  /**
   * @param {Session} s
   * @param {string|number|null} id
   * @param {Parameters<typeof remoteRpcError>[1]} reason
   * @param {Record<string, unknown>} [extra]
   */
  function rpcError(s, id, reason, extra) {
    const locale = s.connection?.locale || DEFAULT_LOCALE;
    return remoteRpcError(id, reason, (message) => word(locale, message), extra);
  }

  /**
   * §17: the connection is minted here, and the phone counts as connected from now on.
   * @param {Session} s
   * @param {string|number} id
   * @param {unknown} params
   */
  function hello(s, id, params) {
    const input = helloParams(params);
    if (!input) {
      send(s, rpcError(s, id, 'invalid-params'));
      return;
    }
    if (!input.protocol.some((v) => SPOKEN_VERSIONS.includes(v))) {
      send(s, rpcError(s, id, 'protocol-unsupported', { protocol: [...SPOKEN_VERSIONS] }));
      return;
    }
    const chosen = Math.max(...input.protocol.filter((v) => SPOKEN_VERSIONS.includes(v)));
    /** @type {import('../ports/remote-message-layer-port').RemoteConnection} */
    const connection = Object.freeze({
      id: newConnectionId(),
      kind: 'relay',
      client: Object.freeze(input.client),
      locale: input.locale,
      capabilities: Object.freeze(input.capabilities),
    });
    const described = messages.describe(connection);
    s.connection = connection;
    send(s, {
      jsonrpc: '2.0',
      id,
      result: {
        protocol: chosen,
        connectionId: connection.id,
        kind: connection.kind,
        app: { version: appVersion() },
        methods: ['session.hello', 'session.bye', ...described.methods],
        approvalResponses: [...described.approvalResponses],
        limits: { ...described.limits },
      },
    });
    messages.open(connection, { send: (event) => s.connection === connection && send(s, event) });
    emit();
  }

  /**
   * A message that opened, in its turn (§16, §17).
   * @param {Session} s
   * @param {string} plaintext
   */
  function deliver(s, plaintext) {
    let message;
    try {
      message = JSON.parse(plaintext);
    } catch {
      // Not JSON: the answer says so (remote-interface.md §6.1), nothing more to report.
      send(s, rpcError(s, null, 'parse'));
      return;
    }
    // Everything the phone sends gets an answer; notifications and batches are not accepted (remote-interface.md §6.1).
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !isRequestId(message.id)
      || (message.params !== undefined && !isRecord(message.params))) {
      send(s, rpcError(s, isRecord(message) && isRequestId(message.id) ? message.id : null, 'invalid-request'));
      return;
    }
    const { id, method } = message;
    const params = isRecord(message.params) ? message.params : {};
    if (!s.connection) {
      if (method === 'session.hello') hello(s, id, params);
      else send(s, rpcError(s, id, 'connection-unknown'));
      return;
    }
    if (method === 'session.hello') {
      // One connection per session; a new one needs a new handshake (§17).
      send(s, rpcError(s, id, 'invalid-request'));
      return;
    }
    if (method === 'session.bye') {
      send(s, { jsonrpc: '2.0', id, result: {} });
      endSession(s, 'bye');
      return;
    }
    const { connection } = s;
    Promise.resolve()
      .then(() => messages.handle(connection, { id, method, params }))
      .then((answer) => {
        if (s.connection === connection) send(s, answer);
      }, (error) => {
        log.warn(`[remote] a request failed (${error?.name || 'error'})`);
        if (s.connection === connection) send(s, rpcError(s, id, 'internal'));
      });
  }

  /**
   * *Starting over* (§16): the session ends; the phone starts a new handshake.
   * @param {Session} s
   * @param {string} why
   */
  function startOver(s, why) {
    log.warn(`[remote] the session starts over (${why})`);
    endSession(s, 'restart');
  }

  /** @param {import('../ports/remote-relay-port').RemoteEnvelope} envelope */
  function onEnvelope({ sid, counter, c }) {
    const target = link;
    const remove = () => target && tidy('deleting an envelope', () => target.deleteEnvelope(sid, counter));
    const s = session;
    if (!s || s.sid !== sid) {
      // Another session's: every session but the current one has ended — this run's
      // that were replaced, and every one from before the desktop started (§16).
      remove();
      return;
    }
    if (counter < s.next || s.held.has(counter)) {
      remove();
      return;
    }
    if (counter > s.next + HOLD_WINDOW || counter >= SESSION_MAX_ENVELOPES) {
      remove();
      startOver(s, 'jump');
      return;
    }
    const plaintext = s.keys.open(counter, c);
    remove();
    if (plaintext === null) {
      startOver(s, 'tag');
      return;
    }
    if (counter > s.next) {
      s.held.set(counter, plaintext);
      s.holdTimer ??= setTimer(() => startOver(s, 'gap'), HOLD_MS);
      return;
    }
    s.next += 1;
    deliver(s, plaintext);
    while (!s.ended && s.held.has(s.next)) {
      const next = /** @type {string} */ (s.held.get(s.next));
      s.held.delete(s.next);
      s.next += 1;
      deliver(s, next);
    }
    if (s.ended) return;
    if (s.holdTimer !== null) clearTimer(s.holdTimer);
    s.holdTimer = s.held.size > 0 ? setTimer(() => startOver(s, 'gap'), HOLD_MS) : null;
    if (s.next >= SESSION_MAX_ENVELOPES) endSession(s, 'limit');
  }

  // ---------------------------------------------------------------- handshake

  /** @param {import('../ports/remote-relay-port').RemotePhoneHandshake | null} record */
  function onPhoneHandshake(record) {
    if (!record || !phone || !own || !link) return;
    if (record.e === answeredE) return;
    if (!crypto.isEphemeralKey(record.e)) {
      log.warn('[remote] a handshake without a valid key was ignored');
      return;
    }
    answeredE = record.e;
    // A new handshake 1 ends the session before it (§13).
    if (session) endSession(session, 'handshake');
    const target = link;
    const shared = record.v.filter((v) => SPOKEN_VERSIONS.includes(v));
    if (shared.length === 0) {
      tidy('answering a handshake', () => target.writeHandshake({ error: 'protocol-unsupported', v: [...SPOKEN_VERSIONS] }));
      return;
    }
    const chosen = Math.max(...shared);
    let answer;
    try {
      answer = crypto.answerHandshake({
        channelId: phone.channelId,
        desktopKeys: own.keys,
        phoneKeys: phone.keys,
        offered: [...record.v],
        chosen,
        phoneEphemeral: record.e,
        agree: own.agree,
      });
    } catch (error) {
      log.warn(`[remote] a handshake could not be answered (${error?.name || 'error'})`);
      return;
    }
    /** @type {Session} */
    const s = {
      keys: answer.session,
      sid: answer.session.sid,
      next: 0,
      out: 0,
      held: new Map(),
      holdTimer: null,
      lifeTimer: null,
      connection: null,
      writes: Promise.resolve(),
      ended: false,
    };
    s.lifeTimer = setTimer(() => endSession(s, 'expired'), SESSION_MAX_MS);
    session = s;
    target.writeHandshake({ v: chosen, e: answer.desktopEphemeral }).catch((error) => {
      log.warn(`[remote] a handshake could not be answered (${error?.reason || error?.name || 'error'})`);
      endSession(s, 'handshake-failed');
    });
  }

  // ---------------------------------------------------------------- the link

  function stopPresence() {
    if (presenceTimer !== null) clearTimer(presenceTimer);
    presenceTimer = null;
  }

  function beat() {
    presenceTimer = null;
    const target = link;
    if (!target || !live) return;
    tidy('writing presence', () => target.writePresence());
    presenceTimer = setTimer(beat, PRESENCE_INTERVAL_MS);
  }

  /**
   * The phone is present while its heartbeat is at most 90 seconds old. A
   * heartbeat ages without an event, so it is judged again the moment it
   * turns stale.
   */
  function judgePhone() {
    if (phoneStaleTimer !== null) clearTimer(phoneStaleTimer);
    phoneStaleTimer = null;
    const age = phoneLastSeen === null ? Infinity : now() - phoneLastSeen;
    phoneOnline = age <= PHONE_PRESENCE_TIMEOUT_MS;
    if (phoneOnline) phoneStaleTimer = setTimer(judgePhone, PHONE_PRESENCE_TIMEOUT_MS - age + 1);
    // The window's indicator needs both (#1196); the session stays what it is.
    emit();
  }

  /**
   * @param {number|null} lastSeen
   * @param {{ observed?: boolean }} [options]  `observed: false` when the desktop dropped the
   *   record itself, closing its link: then the phone did not leave
   */
  function onPhonePresence(lastSeen, { observed = true } = {}) {
    if (lastSeen !== null) phoneLastHere = Math.max(phoneLastHere ?? lastSeen, lastSeen);
    // The phone took its record away (§12.3): it was there until now.
    else if (observed && phoneOnline) phoneLastHere = now();
    phoneLastSeen = lastSeen;
    judgePhone();
  }

  /**
   * Closes the link; the presence record goes first, while the token is still held.
   * @param {{ keepPresence?: boolean }} [options]
   */
  function closeLink({ keepPresence = false } = {}) {
    stopPresence();
    if (session) endSession(session, 'closed');
    answeredE = null;
    const target = link;
    link = null;
    if (target && live && !keepPresence) tidy('deleting presence', () => target.deletePresence());
    live = false;
    onPhonePresence(null, { observed: false });
    target?.close();
  }

  /** @param {number} ms */
  function scheduleReconnect(ms) {
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    const at = generation;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (at === generation && !disposed) connect();
    }, ms);
  }

  /** @param {*} error */
  function onLinkError(error) {
    const reason = error?.reason || 'network';
    link = null;
    closeLink({ keepPresence: true });
    if (reason === 'not-configured') {
      if (!warnedNotConfigured) log.warn('[remote] no relay is configured; the paired phone cannot connect');
      warnedNotConfigured = true;
      return;
    }
    failures += 1;
    log.warn(`[remote] the channel failed (${reason}); trying again later`);
    const ms = TRANSIENT.has(reason)
      ? Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(failures - 1, 10))
      : RECONNECT_REFUSED_MS;
    scheduleReconnect(ms);
  }

  function connect() {
    if (disposed || link || !phone || !own) return;
    const channelId = phone.channelId;
    const handle = relay.openChannel(channelId, {
      sign: own.sign,
      onLive: () => {
        if (link !== handle) return;
        failures = 0;
        live = true;
        if (presenceTimer === null) beat();
      },
      onMeta: (record) => {
        if (link !== handle) return;
        if (record === null) {
          // §12.2: the channel is gone, whatever the other streams still show.
          log.warn('[remote] the relay removed the channel');
          generation += 1;
          phoneLastHere = null;
          closeLink({ keepPresence: true });
          phone = null;
          onGone(channelId);
        } else if (record.status !== 'paired') {
          if (session) endSession(session, 'not-paired');
        }
      },
      onPhoneHandshake: (record) => { if (link === handle) onPhoneHandshake(record); },
      onPhonePresence: (lastSeen) => { if (link === handle) onPhonePresence(lastSeen); },
      onEnvelope: (envelope) => { if (link === handle) onEnvelope(envelope); },
      onError: (error) => { if (link === handle) onLinkError(error); },
    });
    link = handle;
  }

  /**
   * Reads the paired phone again and follows it: connects to a new one,
   * leaves one that was removed. Called on start and whenever pairing changes.
   */
  async function refresh() {
    if (disposed) return;
    const read = ++reads;
    let stored = null;
    try {
      stored = identity.isAvailable() ? await identity.readPhone() : null;
    } catch (error) {
      log.warn(`[remote] the paired phone could not be read (${error?.name || 'error'})`);
    }
    if (read !== reads || disposed) return;
    if (phone && stored && phone.channelId === stored.channelId && (link || reconnectTimer !== null)) return;
    const at = ++generation;
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    reconnectTimer = null;
    // Another phone, or none: what was seen of the one before is not its.
    if (stored?.channelId !== phone?.channelId) phoneLastHere = null;
    closeLink();
    phone = stored;
    failures = 0;
    if (!phone) return;
    try {
      // A phone is paired, so the keys exist already: this creates none.
      own = await identity.loadIdentity();
    } catch (error) {
      log.warn(`[remote] the identity keys could not be read (${error?.name || 'error'})`);
      return;
    }
    if (at !== generation || disposed) return;
    connect();
  }

  /** At quit: the presence record goes, the streams close. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    reconnectTimer = null;
    closeLink();
    listeners.clear();
  }

  /** @param {(state: ChannelState) => void} listener */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    start: refresh,
    refresh,
    dispose,
    subscribe,
    isConnected: connected,
    /** For tests and diagnostics: whether the streams stand and the phone's heartbeat is fresh. */
    inspect: () => ({ linked: !!link, live, phoneOnline, session: session ? { next: session.next, out: session.out, held: session.held.size } : null }),
  };
}

module.exports = {
  createRemoteChannel,
  HOLD_MS,
  HOLD_WINDOW,
  PHONE_PRESENCE_TIMEOUT_MS,
  PRESENCE_INTERVAL_MS,
  SESSION_MAX_MS,
  SPOKEN_VERSIONS,
};
