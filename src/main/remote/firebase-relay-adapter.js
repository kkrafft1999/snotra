'use strict';

/**
 * The relay of the mobile remote over Firebase (#1114), without the Firebase
 * SDK in main (docs/remote-protocol.md §5.1):
 *
 * - the relay's endpoints (Cloud Functions) over HTTPS, `/v1/…`;
 * - the Identity Toolkit's `accounts:signInWithCustomToken` to turn the
 *   relay's custom token into an ID token;
 * - the Realtime Database's REST streaming (server-sent events,
 *   `Accept: text/event-stream`, `?auth=<ID token>`) to follow the channel's
 *   `meta` node — never the channel itself, whose read access would cascade
 *   into the phone's inbox (§5.10, #1142).
 *
 * Tokens live in this adapter's memory and nowhere else: not on disk, not in
 * an error, not in a log line. What the relay answers is checked for its
 * shape before the core sees it; anything else is `invalid-response`.
 *
 * Part 2 (#1192): `openChannel` holds the desktop's token for a paired
 * channel, renews it before it runs out and on `auth_revoked`, follows the
 * four nodes of §12, and writes silently (`print=silent`) — the database
 * would otherwise echo every envelope back.
 *
 * Building the adapter does nothing. The first request goes out when the user
 * starts a pairing or removes a phone, or when the channel is started with a
 * phone paired (R7).
 */

const { readEventStream } = require('./event-stream');
const { counterKey } = require('./channel-protocol');
const { RELAY_REASONS, RemoteRelayError, reasonForStatus, toRelayError } = require('./relay-error');
const protocol = require('./pairing-protocol');

const DEFAULT_IDENTITY_TOOLKIT_URL = 'https://identitytoolkit.googleapis.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;
/** The relay takes bodies up to 4 KiB (§5.1); its answers are smaller still. */
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_TOKEN_CHARS = 8 * 1024;
/** A stream that fails this many times in a row, without one good connection between, is given up. */
const STREAM_ATTEMPTS = 3;
const STREAM_RETRY_MS = 1_000;
/** The nodes the desktop follows in part 2 (§12). */
const CHANNEL_NODES = 4;

/** An ID token is renewed this long before it runs out (§12), and never sooner than the floor after the last one. */
const TOKEN_RENEW_MARGIN_MS = 5 * 60_000;
const TOKEN_RENEW_FLOOR_MS = 30_000;
/**
 * The inbox may hold envelopes of up to 256 KiB plaintext each, base64url in
 * JSON, several at once in the first `put`; every other node is small.
 */
const INBOX_MAX_EVENT_CHARS = 4 * 1024 * 1024;
const HEX16 = /^[0-9a-f]{16}$/;
const MAX_EPHEMERAL_CHARS = 64;

const PAIRING_ID = new RegExp(`^[${protocol.ALPHABET}]{4}$`);
const PATH_PART = /^[A-Za-z0-9_-]+$/;
/** Names a plain object resolves to something other than its own data. */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
/** @param {string} part */
const isPathPart = (part) => PATH_PART.test(part) && !RESERVED.has(part);

/** @typedef {'open' | 'pending' | 'paired'} ChannelStatus */
/**
 * @param {unknown} value
 * @returns {value is ChannelStatus}
 */
const isChannelStatus = (value) => value === 'open' || value === 'pending' || value === 'paired';

/** @typedef {import('../../application/ports/remote-relay-port').RemoteRelayPort} RemoteRelayPort */
/** @typedef {import('../../application/ports/remote-relay-port').RemoteSigner} RemoteSigner */

/**
 * @typedef {Object} FirebaseRelayEndpoint
 * @property {string} relayHost  the host the QR code names
 * @property {string} [relayUrl]  the endpoints' base; `https://<relayHost>/v1` by default
 * @property {string} databaseUrl  the Realtime Database, e.g. `https://<db>.firebasedatabase.app`
 * @property {string} apiKey  the project's web API key, for the Identity Toolkit
 * @property {string} [identityToolkitUrl]  the emulator's, for tests against it
 */

/**
 * An object that is not an array — a node of the database's tree.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A node of the Realtime Database for its REST interface: `<path>.json` with
 * the ID token as `auth`. The database's own query stays — the emulator names
 * its instance as `?ns=<instance>`, and the path goes before it.
 *
 * @param {string} databaseUrl
 * @param {string} nodePath  without leading or trailing `/`
 * @param {string} idToken
 */
function databaseNodeUrl(databaseUrl, nodePath, idToken) {
  const url = new URL(databaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${nodePath}.json`;
  url.searchParams.set('auth', idToken);
  return url.href;
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultWait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(undefined);
    }, { once: true });
  });
}

/**
 * The body as text, refused once it grows past `limit` bytes.
 * @param {Response} response
 * @param {number} limit
 */
async function readLimited(response, limit) {
  if (!response.body) return '';
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {unknown} value */
function keyBundleOf(value) {
  if (!isRecord(value) || typeof value.sign !== 'string' || typeof value.agree !== 'string') return null;
  return { sign: value.sign, agree: value.agree };
}

/**
 * What the desktop reads of a channel's `meta` (§5.10), from the database's tree. Keys
 * and the MAC keep their strings — whether they are valid points and the right
 * MAC is the core's question, asked through the crypto port.
 *
 * @param {unknown} tree
 * @returns {import('../../application/ports/remote-relay-port').RemoteChannelRecord | null | undefined}
 *   `undefined` for a tree that is no channel at all
 */
function channelRecordOf(tree) {
  if (tree === null || tree === undefined) return null;
  if (!isRecord(tree) || !isChannelStatus(tree.status)) return undefined;
  return {
    status: tree.status,
    phoneKeys: keyBundleOf(tree.phoneKeys),
    macP: typeof tree.macP === 'string' ? tree.macP : null,
  };
}

/**
 * Handshake 1 (§13) from the database's tree; `null` when there is none or it
 * is not one — the shape only, the key is the crypto port's question.
 *
 * @param {unknown} tree
 * @returns {import('../../application/ports/remote-relay-port').RemotePhoneHandshake | null}
 */
function phoneHandshakeOf(tree) {
  if (!isRecord(tree) || !Array.isArray(tree.v) || typeof tree.e !== 'string' || tree.e.length > MAX_EPHEMERAL_CHARS) return null;
  const v = tree.v;
  if (v.length === 0 || v.length > 16 || !v.every((n) => Number.isInteger(n) && n >= 1 && n <= 255)) return null;
  return { v: [...v], e: tree.e };
}

/**
 * The envelopes of an inbox (§15), from `{ sid: { counter: { c, at } } }`; anything else is left out.
 * @param {unknown} tree
 * @returns {import('../../application/ports/remote-relay-port').RemoteEnvelope[]}
 */
function envelopesOf(tree) {
  /** @type {import('../../application/ports/remote-relay-port').RemoteEnvelope[]} */
  const out = [];
  if (!isRecord(tree)) return out;
  for (const [sid, bySid] of Object.entries(tree)) {
    if (!HEX16.test(sid) || !isRecord(bySid)) continue;
    for (const [key, record] of Object.entries(bySid)) {
      if (!HEX16.test(key) || !isRecord(record) || typeof record.c !== 'string') continue;
      const counter = Number.parseInt(key, 16);
      if (Number.isSafeInteger(counter)) out.push({ sid, counter, c: record.c });
    }
  }
  return out.sort((a, b) => (a.sid === b.sid ? a.counter - b.counter : a.sid < b.sid ? -1 : 1));
}

/**
 * Applies a `put` (replace) or `patch` (merge the children) at a path of the
 * database's tree. Path parts and keys are checked, so a relay cannot reach
 * `__proto__`; a change at a path that fails the check leaves the tree as it
 * was, the same object.
 *
 * @param {unknown} tree
 * @param {unknown} path
 * @param {unknown} data
 * @param {boolean} merge
 * @returns {unknown}
 */
function applyAt(tree, path, data, merge) {
  const parts = String(path).split('/').filter(Boolean);
  if (!parts.every(isPathPart)) return tree;
  /**
   * @param {unknown} node
   * @param {string} key
   * @param {unknown} value
   * @returns {Record<string, unknown>}
   */
  const set = (node, key, value) => {
    /** @type {Record<string, unknown>} */
    const next = isRecord(node) ? { ...node } : {};
    if (value === null) delete next[key];
    else next[key] = value;
    return next;
  };
  /**
   * @param {unknown} node
   * @param {number} depth
   * @returns {unknown}
   */
  const write = (node, depth) => {
    if (depth === parts.length) {
      if (!merge) return data;
      if (!isRecord(data)) return node;
      /** @type {Record<string, unknown>} */
      let next = isRecord(node) ? node : {};
      for (const [key, value] of Object.entries(data)) {
        if (isPathPart(key)) next = set(next, key, value);
      }
      return next;
    }
    const child = write(isRecord(node) ? node[parts[depth]] : undefined, depth + 1);
    return set(node, parts[depth], child === undefined ? null : child);
  };
  return write(tree, 0);
}

/**
 * @param {{
 *   endpoint: FirebaseRelayEndpoint | null,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   wait?: (ms: number, signal: AbortSignal) => Promise<void>,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 *   timeoutMs?: number,
 * }} deps  without an `endpoint` every call fails with `not-configured`
 * @returns {import('../../application/ports/remote-relay-port').RemoteRelayPort}
 */
function createFirebaseRelayAdapter({
  endpoint,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  wait = defaultWait,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(/** @type {any} */ (timer)),
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  /**
   * channelId → the desktop's ID token for it
   * @type {Map<string, string>}
   */
  const tokens = new Map();
  /**
   * every stream still followed
   * @type {Set<AbortController>}
   */
  const streams = new Set();
  /**
   * every channel link still open (part 2)
   * @type {Set<() => void>}
   */
  const links = new Set();

  /** The endpoint, or `not-configured` when there is none. */
  function requireEndpoint() {
    if (!endpoint) throw new RemoteRelayError(RELAY_REASONS.NOT_CONFIGURED);
    return endpoint;
  }

  /** @param {string} route */
  function relayUrl(route) {
    const { relayUrl: base, relayHost } = requireEndpoint();
    return `${base || `https://${relayHost}/v1`}${route}`;
  }

  /**
   * One request with a JSON body or none; answers the parsed JSON, `null` for 204.
   *
   * @param {string} url
   * @param {{ method?: string, body?: unknown, idToken?: string }} [options]
   * @returns {Promise<unknown>}
   */
  async function call(url, { method = 'POST', body, idToken } = {}) {
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idToken) headers.Authorization = `Bearer ${idToken}`;
    let response;
    let text;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await readLimited(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw toRelayError(error);
    }
    if (!response.ok) throw new RemoteRelayError(reasonForStatus(response.status), { status: response.status });
    if (response.status === 204 || text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      // A body that is no JSON is no answer of the relay's.
      throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE, { status: response.status });
    }
  }

  /**
   * §5.1: the relay's custom token becomes an ID token through the Identity Toolkit.
   * @param {unknown} customToken
   * @returns {Promise<{ idToken: string, expiresInMs: number }>}
   */
  async function signIn(customToken) {
    if (typeof customToken !== 'string' || !customToken || customToken.length > MAX_TOKEN_CHARS) {
      throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    }
    const { identityToolkitUrl, apiKey } = requireEndpoint();
    const base = identityToolkitUrl || DEFAULT_IDENTITY_TOOLKIT_URL;
    const answer = await call(`${base}/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`, {
      body: { token: customToken, returnSecureToken: true },
    });
    const idToken = isRecord(answer) ? answer.idToken : undefined;
    if (typeof idToken !== 'string' || !idToken || idToken.length > MAX_TOKEN_CHARS) {
      throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    }
    // The Identity Toolkit names the lifetime in seconds, as a string; an hour when it does not.
    const seconds = Number(isRecord(answer) ? answer.expiresIn : undefined);
    const expiresInMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 3_600_000;
    return { idToken, expiresInMs };
  }

  /** §5.2: a challenge, as the bytes every proof signs. */
  async function challenge() {
    const answer = await call(relayUrl('/challenges'));
    const text = isRecord(answer) ? answer.challenge : undefined;
    const bytes = protocol.fromB64u(text);
    if (typeof text !== 'string' || !bytes || bytes.length === 0 || bytes.length > 64) throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    return { text, bytes };
  }

  /**
   * §5.9: a token for a channel the desktop opened in an earlier start.
   * @param {string} channelId
   * @param {RemoteSigner} sign
   */
  async function fetchToken(channelId, sign) {
    const { text, bytes } = await challenge();
    const proof = sign(protocol.tokenMessage(bytes, channelId, protocol.ROLES.DESKTOP));
    const answer = await call(relayUrl('/tokens'), {
      body: { challenge: text, channelId, role: protocol.ROLES.DESKTOP, proof: protocol.toB64u(proof) },
    });
    const { idToken } = await signIn(isRecord(answer) ? answer.token : undefined);
    tokens.set(channelId, idToken);
    return idToken;
  }

  /** @param {string} channelId */
  function tokenFor(channelId) {
    const idToken = tokens.get(channelId);
    if (!idToken) throw new RemoteRelayError(RELAY_REASONS.UNAUTHORIZED);
    return idToken;
  }

  /** @type {RemoteRelayPort['openPairing']} */
  async function openPairing({ desktopKeys, sign }) {
    const { text, bytes } = await challenge();
    const proof = sign(protocol.openMessage(bytes, desktopKeys));
    const answer = await call(relayUrl('/pairings'), {
      body: { challenge: text, desktopKeys: { sign: desktopKeys.sign, agree: desktopKeys.agree }, proof: protocol.toB64u(proof) },
    });
    const fields = isRecord(answer) ? answer : {};
    const channelId = fields.channelId;
    if (typeof channelId !== 'string' || !protocol.fromB64u(channelId, protocol.CHANNEL_ID_BYTES)
      || typeof fields.pairingId !== 'string' || !PAIRING_ID.test(fields.pairingId)
      || typeof fields.expiresAt !== 'number' || !Number.isFinite(fields.expiresAt)) {
      throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    }
    tokens.set(channelId, (await signIn(fields.token)).idToken);
    return { channelId, pairingId: fields.pairingId, expiresAt: fields.expiresAt, relayHost: requireEndpoint().relayHost };
  }

  /** @type {RemoteRelayPort['watchChannel']} */
  function watchChannel(channelId, { onRecord, onError }) {
    const controller = new AbortController();
    streams.add(controller);
    const stop = () => {
      controller.abort();
      streams.delete(controller);
    };

    /**
     * One connection, until the stream ends; `true` once the channel is gone for good.
     * @param {() => void} onLive
     * @returns {Promise<boolean>}
     */
    async function connect(onLive) {
      if (!endpoint) throw new RemoteRelayError(RELAY_REASONS.NOT_CONFIGURED);
      const url = databaseNodeUrl(endpoint.databaseUrl, `channels/${channelId}/meta`, tokenFor(channelId));
      const response = await fetchImpl(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
      if (!response.ok || !response.body) {
        throw new RemoteRelayError(reasonForStatus(response.status), { status: response.status });
      }
      /** @type {unknown} */
      let tree;
      let gone = false;
      await readEventStream(response.body, ({ type, data }) => {
        if (gone || controller.signal.aborted) return;
        if (type === 'put' || type === 'patch') {
          onLive();
          let change;
          try {
            change = JSON.parse(data);
          } catch {
            // An event that is no JSON changes nothing; the next full put repairs the copy.
            return;
          }
          if (!isRecord(change) || typeof change.path !== 'string') return;
          const next = applyAt(tree, change.path, change.data, type === 'patch');
          if (next === tree && tree !== undefined) return;
          tree = next;
          const record = channelRecordOf(tree);
          if (record !== undefined) onRecord(record);
          gone = record === null;
        } else if (type === 'cancel') {
          // The rules took the channel away from the desktop: for the desktop it is gone.
          gone = true;
          onRecord(null);
        } else if (type === 'auth_revoked') {
          throw new RemoteRelayError(RELAY_REASONS.UNAUTHORIZED);
        }
      });
      return gone;
    }

    /**
     * Follows the channel across dropped connections. A network failure or
     * an outage is tried again, with a growing pause; anything else — a
     * refused token, a missing configuration — ends it at once, as does
     * `STREAM_ATTEMPTS` failures without a live connection between them.
     */
    async function follow() {
      let failures = 0;
      while (!controller.signal.aborted) {
        let failure = new RemoteRelayError(RELAY_REASONS.NETWORK);
        try {
          if (await connect(() => { failures = 0; })) {
            stop();
            return;
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          failure = toRelayError(error);
        }
        failures += 1;
        const transient = failure.reason === RELAY_REASONS.NETWORK || failure.reason === RELAY_REASONS.UNAVAILABLE;
        if (!transient || failures >= STREAM_ATTEMPTS) {
          stop();
          onError(failure);
          return;
        }
        await wait(STREAM_RETRY_MS * failures, controller.signal);
      }
    }

    void follow().catch((error) => {
      // follow() catches inside its loop; this is the last line of defence.
      if (controller.signal.aborted) return;
      stop();
      onError(toRelayError(error));
    });
    return { close: stop };
  }

  /**
   * Part 2 (§12): the desktop's token for a paired channel, the four nodes it
   * follows — `meta`, `to-desktop`, `handshake/phone`, `presence/phone` —
   * and its writes. The token is renewed before it runs out and on
   * `auth_revoked`; it never leaves this closure.
   *
   * @type {RemoteRelayPort['openChannel']}
   */
  function openChannel(channelId, handlers) {
    const controller = new AbortController();
    streams.add(controller);
    let closed = false;
    /** @type {string | null} */
    let idToken = null;
    /** @type {Promise<string> | null} */
    let renewing = null;
    /** @type {unknown} */
    let renewTimer = null;
    /** The nodes whose stream has delivered since it last (re)connected. */
    const liveNodes = new Set();

    function close() {
      if (closed) return;
      closed = true;
      controller.abort();
      streams.delete(controller);
      links.delete(close);
      if (renewTimer !== null) clearTimer(renewTimer);
      renewTimer = null;
      idToken = null;
    }

    /** @param {unknown} error */
    function fail(error) {
      if (closed) return;
      close();
      handlers.onError(toRelayError(error));
    }

    /** §5.9 and the Identity Toolkit; one renewal at a time. */
    function renew() {
      renewing ??= (async () => {
        const { text, bytes } = await challenge();
        const proof = handlers.sign(protocol.tokenMessage(bytes, channelId, protocol.ROLES.DESKTOP));
        const answer = await call(relayUrl('/tokens'), {
          body: { challenge: text, channelId, role: protocol.ROLES.DESKTOP, proof: protocol.toB64u(proof) },
        });
        const signedIn = await signIn(isRecord(answer) ? answer.token : undefined);
        if (closed) throw new RemoteRelayError(RELAY_REASONS.NETWORK);
        idToken = signedIn.idToken;
        if (renewTimer !== null) clearTimer(renewTimer);
        renewTimer = setTimer(() => {
          renewTimer = null;
          renew().catch(fail);
        }, Math.max(TOKEN_RENEW_FLOOR_MS, signedIn.expiresInMs - TOKEN_RENEW_MARGIN_MS));
        return signedIn.idToken;
      })().finally(() => { renewing = null; });
      return renewing;
    }

    async function currentToken() {
      if (renewing) return renewing;
      return idToken ?? renew();
    }

    /**
     * One node, followed across dropped connections, as `watchChannel` follows `meta`.
     * @param {string} name  the node under the channel
     * @param {(tree: unknown) => boolean | void} onTree  true once the channel is gone for good
     * @param {number} [maxEventChars]
     */
    async function follow(name, onTree, maxEventChars) {
      let failures = 0;
      while (!closed) {
        let failure = new RemoteRelayError(RELAY_REASONS.NETWORK);
        let used = null;
        try {
          used = await currentToken();
          if (closed) return;
          if (!endpoint) throw new RemoteRelayError(RELAY_REASONS.NOT_CONFIGURED);
          liveNodes.delete(name);
          const url = databaseNodeUrl(endpoint.databaseUrl, `channels/${channelId}/${name}`, used);
          const response = await fetchImpl(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
          if (!response.ok || !response.body) throw new RemoteRelayError(reasonForStatus(response.status), { status: response.status });
          /** @type {unknown} */
          let tree;
          let gone = false;
          await readEventStream(response.body, ({ type, data }) => {
            if (gone || closed) return;
            if (type === 'put' || type === 'patch') {
              failures = 0;
              let change;
              try {
                change = JSON.parse(data);
              } catch {
                // An event that is no JSON changes nothing; the next full put repairs the copy.
                return;
              }
              if (!isRecord(change) || typeof change.path !== 'string') return;
              tree = applyAt(tree, change.path, change.data, type === 'patch');
              if (!liveNodes.has(name)) {
                liveNodes.add(name);
                if (liveNodes.size === CHANNEL_NODES) queueMicrotask(() => { if (!closed) handlers.onLive(); });
              }
              gone = onTree(tree) === true;
              // The database keeps the stream open; the link ends here, every stream with it.
              if (gone) queueMicrotask(close);
            } else if (type === 'cancel') {
              // The rules took the node away: `meta` gone is the end of the channel (§12.2).
              if (name === 'meta') {
                gone = true;
                handlers.onMeta(null);
                queueMicrotask(close);
              } else {
                throw new RemoteRelayError(RELAY_REASONS.REFUSED);
              }
            } else if (type === 'auth_revoked') {
              throw new RemoteRelayError(RELAY_REASONS.UNAUTHORIZED);
            }
          }, maxEventChars ? { maxEventChars } : undefined);
          if (gone) {
            close();
            return;
          }
        } catch (error) {
          if (closed) return;
          failure = toRelayError(error);
        }
        failures += 1;
        if (failure.reason === RELAY_REASONS.UNAUTHORIZED && failures < STREAM_ATTEMPTS) {
          // §12: on `auth_revoked` renew — once per token, whichever stream notices first.
          try {
            if (idToken === used) await renew();
          } catch (error) {
            fail(error);
            return;
          }
          continue;
        }
        const transient = failure.reason === RELAY_REASONS.NETWORK || failure.reason === RELAY_REASONS.UNAVAILABLE;
        if (!transient || failures >= STREAM_ATTEMPTS) {
          fail(failure);
          return;
        }
        await wait(STREAM_RETRY_MS * failures, controller.signal);
      }
    }

    /** @type {Set<string>} */
    const reported = new Set();
    let handshakeSeen = /** @type {string|undefined} */ (undefined);
    let presenceSeen = /** @type {boolean|undefined} */ (undefined);
    const nodes = [
      follow('meta', (tree) => {
        const record = channelRecordOf(tree);
        if (record === undefined) return false;
        handlers.onMeta(record);
        return record === null;
      }),
      follow('to-desktop', (tree) => {
        const present = new Set();
        for (const envelope of envelopesOf(tree)) {
          const id = `${envelope.sid}/${counterKey(envelope.counter)}`;
          present.add(id);
          if (reported.has(id)) continue;
          reported.add(id);
          handlers.onEnvelope(envelope);
        }
        for (const id of reported) if (!present.has(id)) reported.delete(id);
      }, INBOX_MAX_EVENT_CHARS),
      follow('handshake/phone', (tree) => {
        const record = phoneHandshakeOf(tree);
        const key = JSON.stringify(record);
        if (key === handshakeSeen) return;
        handshakeSeen = key;
        handlers.onPhoneHandshake(record);
      }),
      follow('presence/phone', (tree) => {
        const online = tree !== null && tree !== undefined;
        if (online === presenceSeen) return;
        presenceSeen = online;
        handlers.onPhonePresence(online);
      }),
    ];
    for (const node of nodes) node.catch(fail);
    links.add(close);

    /**
     * One write under the channel, silent (`print=silent`, 204): the database
     * would otherwise echo an envelope back. A refused token is renewed once.
     *
     * @param {string} nodePath
     * @param {'PUT'|'DELETE'} method
     * @param {unknown} [body]
     */
    async function write(nodePath, method, body) {
      if (closed) throw new RemoteRelayError(RELAY_REASONS.UNAUTHORIZED);
      const { databaseUrl } = requireEndpoint();
      for (let attempt = 0; ; attempt += 1) {
        const used = await currentToken();
        const url = new URL(databaseNodeUrl(databaseUrl, `channels/${channelId}/${nodePath}`, used));
        url.searchParams.set('print', 'silent');
        try {
          await call(url.href, { method, body });
          return;
        } catch (error) {
          if (attempt > 0 || closed || !(error instanceof RemoteRelayError) || error.reason !== RELAY_REASONS.UNAUTHORIZED) throw error;
          if (idToken === used) await renew();
        }
      }
    }

    /** @param {string} sid @param {number} counter */
    const envelopeKey = (sid, counter) => {
      if (!HEX16.test(sid) || !Number.isSafeInteger(counter) || counter < 0) throw new RemoteRelayError(RELAY_REASONS.INVALID_REQUEST);
      return `${sid}/${counterKey(counter)}`;
    };

    return {
      writeHandshake: (record) => write('handshake/desktop', 'PUT', record),
      writeEnvelope: async (sid, counter, c) => write(`to-phone/${envelopeKey(sid, counter)}`, 'PUT', { c, at: { '.sv': 'timestamp' } }),
      deleteEnvelope: async (sid, counter) => write(`to-desktop/${envelopeKey(sid, counter)}`, 'DELETE'),
      writePresence: () => write('presence/desktop', 'PUT', { lastSeen: { '.sv': 'timestamp' } }),
      deletePresence: () => write('presence/desktop', 'DELETE'),
      close,
    };
  }

  /** @type {RemoteRelayPort['confirmPairing']} */
  async function confirmPairing(channelId, macD) {
    await call(relayUrl(`/channels/${channelId}/confirm`), { body: { macD }, idToken: tokenFor(channelId) });
  }

  /** @type {RemoteRelayPort['cancelPairing']} */
  async function cancelPairing(channelId, pairingId) {
    try {
      await call(relayUrl(`/pairings/${encodeURIComponent(pairingId)}`), { method: 'DELETE', idToken: tokenFor(channelId) });
    } finally {
      tokens.delete(channelId);
    }
  }

  /** @type {RemoteRelayPort['deleteChannel']} */
  async function deleteChannel(channelId, { sign }) {
    /** @param {string} idToken */
    const remove = (idToken) => call(relayUrl(`/channels/${channelId}`), { method: 'DELETE', idToken });
    try {
      const held = tokens.get(channelId);
      try {
        await remove(held || await fetchToken(channelId, sign));
      } catch (error) {
        // A token held since the pairing may have run out: one fresh one, then give up.
        if (!held || !(error instanceof RemoteRelayError) || error.reason !== RELAY_REASONS.UNAUTHORIZED) throw error;
        await remove(await fetchToken(channelId, sign));
      }
    } finally {
      tokens.delete(channelId);
    }
  }

  function close() {
    for (const closeLink of [...links]) closeLink();
    for (const controller of streams) controller.abort();
    streams.clear();
    tokens.clear();
  }

  return { openPairing, watchChannel, confirmPairing, cancelPairing, deleteChannel, openChannel, close };
}

module.exports = {
  createFirebaseRelayAdapter,
  applyAt,
  channelRecordOf,
  databaseNodeUrl,
  envelopesOf,
  phoneHandshakeOf,
  STREAM_ATTEMPTS,
  TOKEN_RENEW_MARGIN_MS,
};
