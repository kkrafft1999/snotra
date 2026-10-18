'use strict';

/**
 * The relay of the mobile remote over Firebase (#1114), without the Firebase
 * SDK in main (docs/remote-protocol.md §5.1):
 *
 * - the relay's endpoints (Cloud Functions) over HTTPS, `/v1/…`;
 * - the Identity Toolkit's `accounts:signInWithCustomToken` to turn the
 *   relay's custom token into an ID token;
 * - the Realtime Database's REST streaming (server-sent events,
 *   `Accept: text/event-stream`, `?auth=<ID token>`) to follow the channel.
 *
 * Tokens live in this adapter's memory and nowhere else: not on disk, not in
 * an error, not in a log line. What the relay answers is checked for its
 * shape before the core sees it; anything else is `invalid-response`.
 *
 * Building the adapter does nothing. The first request goes out when the user
 * starts a pairing or removes a phone (R7).
 */

const { readEventStream } = require('./event-stream');
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

const PAIRING_ID = new RegExp(`^[${protocol.ALPHABET}]{4}$`);
const PATH_PART = /^[A-Za-z0-9_-]+$/;
/** Names a plain object resolves to something other than its own data. */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const isPathPart = (part) => PATH_PART.test(part) && !RESERVED.has(part);
const STATUSES = new Set(['open', 'pending', 'paired']);

/**
 * @typedef {Object} FirebaseRelayEndpoint
 * @property {string} relayHost  the host the QR code names
 * @property {string} [relayUrl]  the endpoints' base; `https://<relayHost>/v1` by default
 * @property {string} databaseUrl  the Realtime Database, e.g. `https://<db>.firebasedatabase.app`
 * @property {string} apiKey  the project's web API key, for the Identity Toolkit
 * @property {string} [identityToolkitUrl]  the emulator's, for tests against it
 */

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** @returns {Promise<void>} */
function defaultWait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(undefined);
    }, { once: true });
  });
}

/** The body as text, refused once it grows past `limit` bytes. */
async function readLimited(response, limit) {
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > limit) throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function keyBundleOf(value) {
  if (!isRecord(value) || typeof value.sign !== 'string' || typeof value.agree !== 'string') return null;
  return { sign: value.sign, agree: value.agree };
}

/**
 * What the desktop reads of a channel (§5.10), from the database's tree. Keys
 * and the MAC keep their strings — whether they are valid points and the right
 * MAC is the core's question, asked through the crypto port.
 *
 * @returns {import('../../application/ports/remote-relay-port').RemoteChannelRecord | null | undefined}
 *   `undefined` for a tree that is no channel at all
 */
function channelRecordOf(tree) {
  if (tree === null || tree === undefined) return null;
  if (!isRecord(tree) || !STATUSES.has(tree.status)) return undefined;
  return {
    status: tree.status,
    phoneKeys: keyBundleOf(tree.phoneKeys),
    macP: typeof tree.macP === 'string' ? tree.macP : null,
  };
}

/**
 * Applies a `put` (replace) or `patch` (merge the children) at a path of the
 * database's tree. Path parts and keys are checked, so a relay cannot reach
 * `__proto__`; a change at a path that fails the check leaves the tree as it
 * was, the same object.
 */
function applyAt(tree, path, data, merge) {
  const parts = String(path).split('/').filter(Boolean);
  if (!parts.every(isPathPart)) return tree;
  const set = (node, key, value) => {
    const next = isRecord(node) ? { ...node } : {};
    if (value === null) delete next[key];
    else next[key] = value;
    return next;
  };
  const write = (node, depth) => {
    if (depth === parts.length) {
      if (!merge) return data;
      if (!isRecord(data)) return node;
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
 *   timeoutMs?: number,
 * }} deps  without an `endpoint` every call fails with `not-configured`
 * @returns {import('../../application/ports/remote-relay-port').RemoteRelayPort}
 */
function createFirebaseRelayAdapter({
  endpoint,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  wait = defaultWait,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  /** channelId → the desktop's ID token for it */
  const tokens = new Map();
  /** every stream still followed */
  const streams = new Set();

  function relayUrl(route) {
    if (!endpoint) throw new RemoteRelayError(RELAY_REASONS.NOT_CONFIGURED);
    return `${endpoint.relayUrl || `https://${endpoint.relayHost}/v1`}${route}`;
  }

  /**
   * One request with a JSON body or none; answers the parsed JSON, `null` for 204.
   *
   * @param {string} url
   * @param {{ method?: string, body?: unknown, idToken?: string }} [options]
   * @returns {Promise<any>}
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

  /** §5.1: the relay's custom token becomes an ID token through the Identity Toolkit. */
  async function signIn(customToken) {
    if (typeof customToken !== 'string' || !customToken || customToken.length > MAX_TOKEN_CHARS) {
      throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    }
    const base = endpoint.identityToolkitUrl || DEFAULT_IDENTITY_TOOLKIT_URL;
    const answer = await call(`${base}/accounts:signInWithCustomToken?key=${encodeURIComponent(endpoint.apiKey)}`, {
      body: { token: customToken, returnSecureToken: true },
    });
    const idToken = answer?.idToken;
    if (typeof idToken !== 'string' || !idToken || idToken.length > MAX_TOKEN_CHARS) {
      throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    }
    return idToken;
  }

  /** §5.2: a challenge, as the bytes every proof signs. */
  async function challenge() {
    const answer = await call(relayUrl('/challenges'));
    const text = answer?.challenge;
    const bytes = protocol.fromB64u(text);
    if (!bytes || bytes.length === 0 || bytes.length > 64) throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    return { text, bytes };
  }

  /** §5.9: a token for a channel the desktop opened in an earlier start. */
  async function fetchToken(channelId, sign) {
    const { text, bytes } = await challenge();
    const proof = sign(protocol.tokenMessage(bytes, channelId, protocol.ROLES.DESKTOP));
    const answer = await call(relayUrl('/tokens'), {
      body: { challenge: text, channelId, role: protocol.ROLES.DESKTOP, proof: protocol.toB64u(proof) },
    });
    const idToken = await signIn(answer?.token);
    tokens.set(channelId, idToken);
    return idToken;
  }

  function tokenFor(channelId) {
    const idToken = tokens.get(channelId);
    if (!idToken) throw new RemoteRelayError(RELAY_REASONS.UNAUTHORIZED);
    return idToken;
  }

  async function openPairing({ desktopKeys, sign }) {
    const { text, bytes } = await challenge();
    const proof = sign(protocol.openMessage(bytes, desktopKeys));
    const answer = await call(relayUrl('/pairings'), {
      body: { challenge: text, desktopKeys: { sign: desktopKeys.sign, agree: desktopKeys.agree }, proof: protocol.toB64u(proof) },
    });
    const channelId = answer?.channelId;
    if (!protocol.fromB64u(channelId, protocol.CHANNEL_ID_BYTES)
      || typeof answer.pairingId !== 'string' || !PAIRING_ID.test(answer.pairingId)
      || !Number.isFinite(answer.expiresAt)) {
      throw new RemoteRelayError(RELAY_REASONS.INVALID_RESPONSE);
    }
    tokens.set(channelId, await signIn(answer.token));
    return { channelId, pairingId: answer.pairingId, expiresAt: answer.expiresAt, relayHost: endpoint.relayHost };
  }

  function watchChannel(channelId, { onRecord, onError }) {
    const controller = new AbortController();
    streams.add(controller);
    const stop = () => {
      controller.abort();
      streams.delete(controller);
    };

    /** One connection, until the stream ends; `true` once the channel is gone for good. */
    async function connect(onLive) {
      if (!endpoint) throw new RemoteRelayError(RELAY_REASONS.NOT_CONFIGURED);
      const url = `${endpoint.databaseUrl}/channels/${channelId}.json?auth=${encodeURIComponent(tokenFor(channelId))}`;
      const response = await fetchImpl(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
      if (!response.ok || !response.body) {
        throw new RemoteRelayError(reasonForStatus(response.status), { status: response.status });
      }
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

  async function confirmPairing(channelId, macD) {
    await call(relayUrl(`/channels/${channelId}/confirm`), { body: { macD }, idToken: tokenFor(channelId) });
  }

  async function cancelPairing(channelId, pairingId) {
    try {
      await call(relayUrl(`/pairings/${encodeURIComponent(pairingId)}`), { method: 'DELETE', idToken: tokenFor(channelId) });
    } finally {
      tokens.delete(channelId);
    }
  }

  async function deleteChannel(channelId, { sign }) {
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
    for (const controller of streams) controller.abort();
    streams.clear();
    tokens.clear();
  }

  return { openPairing, watchChannel, confirmPairing, cancelPairing, deleteChannel, close };
}

module.exports = { createFirebaseRelayAdapter, applyAt, channelRecordOf, STREAM_ATTEMPTS };
