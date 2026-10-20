'use strict';

/**
 * The reference phone of the mobile remote (#1135, phase 3 of #1081): the
 * phone's half of docs/remote-protocol.md over the relay's real interface —
 * HTTP to the relay's endpoints, the Identity Toolkit for an ID token, the
 * Realtime Database's REST interface for what the phone reads and writes.
 * Part 1 pairs; part 2 connects (§12), shakes hands (§13, §14) and exchanges
 * envelopes (§15, §17).
 *
 * It computes what it sends with the reference implementations in
 * scripts/remote-protocol-vectors.js and scripts/remote-protocol-channel-vectors.js,
 * not with the bridge's code in src/main/remote/: what the phone sends and
 * what the desktop checks come from two implementations, as they will with
 * the iPhone app. It needs nothing but this repository and Node 24 —
 * `node:crypto` and `fetch`. The iPhone app follows its nodes through the
 * Firebase SDK; this phone streams them by REST, as the desktop does.
 *
 * Every call answers or throws a RelayAnswer with the HTTP status and the
 * relay's `reason`. Tokens stay in this object: no error, no message and no
 * return value carries one, since snotra-promotion's CI prints what fails.
 */

const nodeCrypto = require('node:crypto');
const ref = require('../../scripts/remote-protocol-vectors');
const channelRef = require('../../scripts/remote-protocol-channel-vectors');
const { readEventStream } = require('../../src/main/remote/event-stream');

const REQUEST_TIMEOUT_MS = 15_000;
/** How long the phone waits for something to show in one of its streams. */
const WAIT_MS = 10_000;
/** What the rules take as the server's time (§12, §15). */
const SERVER_TIME = Object.freeze({ '.sv': 'timestamp' });
/** The nodes the phone follows once paired (§12), `meta` first. */
const PHONE_NODES = Object.freeze(['meta', 'to-phone', 'handshake/desktop', 'presence/desktop']);

const b64u = (/** @type {Uint8Array} */ bytes) => Buffer.from(bytes).toString('base64url');
const fromB64u = (/** @type {string} */ text) => Buffer.from(text, 'base64url');

/** A relay's answer that was not a success, or a success of the wrong shape. */
class RelayAnswer extends Error {
  /**
   * @param {string} what  the call, e.g. `POST /pairings/{id}/claim`
   * @param {number|null} status
   * @param {string|null} reason  the relay's `error.reason`, or what was wrong
   */
  constructor(what, status, reason) {
    super(`${what} answered ${status === null ? 'nothing' : `HTTP ${status}`}${reason ? ` (${reason})` : ''}`);
    this.name = 'RelayAnswer';
    this.what = what;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * The node `nodePath` of the database for its REST interface; the database's
 * own query — the emulator's `?ns=` — stays.
 *
 * @param {string} databaseUrl
 * @param {string} nodePath
 * @param {string} idToken
 */
function databaseNodeUrl(databaseUrl, nodePath, idToken) {
  const url = new URL(databaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${nodePath}.json`;
  url.searchParams.set('auth', idToken);
  return url.href;
}

/**
 * One HTTP exchange. Answers `{ status, body }` for any status; throws a
 * RelayAnswer without status when nothing came back. The URL never reaches an
 * error message — it may carry a token.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} what
 * @param {string} url
 * @param {{ method?: string, body?: unknown, rawBody?: string, headers?: Record<string, string>, timeoutMs?: number }} [options]
 */
async function exchange(fetchImpl, what, url, { method = 'GET', body, rawBody, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  /** @type {Record<string, string>} */
  const sent = { Accept: 'application/json', ...headers };
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) sent['Content-Type'] = 'application/json';
  let response;
  let text;
  try {
    response = await fetchImpl(url, { method, headers: sent, body: payload, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    text = await response.text();
  } catch (error) {
    const cause = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'no connection';
    throw new RelayAnswer(what, null, cause);
  }
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return { status: response.status, body: parsed };
}

/**
 * The relay's reason in an error body (§5.1), or the database's message.
 * @param {unknown} body
 */
function reasonOf(body) {
  if (!body || typeof body !== 'object') return null;
  const error = /** @type {{ error?: unknown }} */ (body).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (/** @type {{ reason?: unknown }} */ (error)).reason === 'string') {
    return /** @type {{ reason: string }} */ (error).reason;
  }
  return null;
}

/** A fresh pair of P-256 keys — sign and agree — as the Secure Enclave would make them. */
function createKeys() {
  const pairs = {
    sign: nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    agree: nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  };
  const point = (/** @type {nodeCrypto.KeyObject} */ key) => {
    const jwk = key.export({ format: 'jwk' });
    return Buffer.concat([Buffer.from([4]), fromB64u(String(jwk.x)), fromB64u(String(jwk.y))]);
  };
  const points = { sign: point(pairs.sign.publicKey), agree: point(pairs.agree.publicKey) };
  const agreeScalar = fromB64u(String(pairs.agree.privateKey.export({ format: 'jwk' }).d));
  return {
    points,
    bundle: { sign: b64u(points.sign), agree: b64u(points.agree) },
    sign: (/** @type {Uint8Array} */ message) => nodeCrypto.sign('sha256', message, { key: pairs.sign.privateKey, dsaEncoding: 'ieee-p1363' }),
    /** `ss` of §14 with the other side's agree point, base64url as the bridge's identity port takes it. */
    agree: (/** @type {string} */ otherAgreePoint) => channelRef.staticShared(agreeScalar, fromB64u(otherAgreePoint)),
  };
}

/** A counter or a session id as it names an envelope: 16 lower-case hex digits (§15). */
const hex16 = (/** @type {number} */ counter) => counter.toString(16).padStart(16, '0');

/** @param {unknown} value */
const isTree = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * A `put` (replace) or `patch` (merge the children) of the database's stream,
 * applied at its path; an empty object becomes null, as in the database.
 *
 * @param {unknown} tree
 * @param {string} path
 * @param {unknown} data
 * @param {boolean} merge
 * @returns {unknown}
 */
function applyAt(tree, path, data, merge) {
  const [head, ...rest] = String(path).split('/').filter(Boolean);
  /** @type {Record<string, unknown>} */
  let next;
  if (head === undefined) {
    if (!merge || !isTree(data)) return data;
    next = isTree(tree) ? { ...tree } : {};
    for (const [key, value] of Object.entries(data)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
  } else {
    next = isTree(tree) ? { ...tree } : {};
    const child = applyAt(next[head], rest.join('/'), data, merge);
    if (child === null || child === undefined) delete next[head];
    else next[head] = child;
  }
  return Object.keys(next).length ? next : null;
}

/**
 * @typedef {Object} RelayConfig
 * @property {string} relayUrl  the endpoints' base, ending in `/v1`
 * @property {string} databaseUrl  the Realtime Database, with `?ns=` for the emulator
 * @property {string} apiKey  the web API key, for the Identity Toolkit
 * @property {string} [identityToolkitUrl]  the emulator's; Google's by default
 * @property {string} appCheckToken  sent in `X-Firebase-AppCheck` — a debug token, never stored
 */

/**
 * @param {RelayConfig & { fetchImpl?: typeof fetch, timeoutMs?: number, waitMs?: number }} config
 */
function createReferencePhone({
  relayUrl,
  databaseUrl,
  apiKey,
  identityToolkitUrl = 'https://identitytoolkit.googleapis.com/v1',
  appCheckToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  waitMs = WAIT_MS,
}) {
  const keys = createKeys();
  /** @type {string|null} */
  let idToken = null;
  /** What the phone learned while pairing: the code, the channel, the desktop's keys. */
  /** @type {{ code: string, pairingId: string, channelId: string, desktopKeys: { sign: string, agree: string } } | null} */
  let pairing = null;
  /** The streams of part 2, by node; empty until `connect()`. */
  /** @type {Map<string, ReturnType<typeof followNode>>} */
  const streams = new Map();
  /** A handshake 1 written and not answered yet: its ephemeral key, its versions, the answer it found before. */
  /** @type {{ ephemeral: Buffer, publicKey: Buffer, offered: number[], before: string } | null} */
  let offer = null;
  /** The session the last handshake made (§14), or null. */
  /** @type {{ toDesktop: Buffer, toPhone: Buffer, sid: Buffer, next: number, out: number } | null} */
  let session = null;
  let requests = 0;

  /**
   * A call to the relay that has to answer `expect`; anything else throws.
   *
   * @param {string} method
   * @param {string} route  after `/v1`
   * @param {{ body?: unknown, rawBody?: string, appCheck?: boolean, bearer?: string|null, expect?: number }} [options]
   */
  async function relay(method, route, { body, rawBody, appCheck = false, bearer = null, expect = 200 } = {}) {
    const what = `${method} ${route.replace(/\/[A-Za-z0-9_-]{22}(?=\/|$)/, '/{channelId}').replace(/\/pairings\/[^/]+/, '/pairings/{pairingId}')}`;
    /** @type {Record<string, string>} */
    const headers = {};
    if (appCheck) headers['X-Firebase-AppCheck'] = appCheckToken;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const answer = await exchange(fetchImpl, what, `${relayUrl}${route}`, { method, body, rawBody, headers, timeoutMs });
    if (answer.status !== expect) throw new RelayAnswer(what, answer.status, reasonOf(answer.body));
    if (answer.body === undefined) throw new RelayAnswer(what, answer.status, 'not JSON');
    return answer.body;
  }

  /** §5.1: the relay's custom token becomes an ID token. */
  /** @param {unknown} customToken */
  async function signIn(customToken) {
    if (typeof customToken !== 'string' || !customToken) throw new RelayAnswer('the custom token', 200, 'missing');
    const what = 'accounts:signInWithCustomToken';
    const answer = await exchange(fetchImpl, what, `${identityToolkitUrl}/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', body: { token: customToken, returnSecureToken: true }, timeoutMs,
    });
    const token = answer.body && typeof answer.body === 'object' ? answer.body.idToken : undefined;
    if (answer.status !== 200 || typeof token !== 'string' || !token) throw new RelayAnswer(what, answer.status, reasonOf(answer.body));
    return token;
  }

  /** §5.2 */
  async function challenge() {
    const answer = await relay('POST', '/challenges');
    const text = answer?.challenge;
    if (typeof text !== 'string' || fromB64u(text).length === 0 || fromB64u(text).length > 64) {
      throw new RelayAnswer('POST /challenges', 200, 'no challenge of 1 to 64 bytes');
    }
    return text;
  }

  function requirePairing() {
    if (!pairing) throw new Error('the phone has not looked a pairing up');
    return pairing;
  }

  /**
   * How a node of the channel is named in what fails: ids become placeholders.
   * @param {string} relative
   */
  const nodeName = (relative) => `/channels/{channelId}/${relative.replace(/[0-9a-f]{16}/g, (_, at) => (at === relative.indexOf('/') + 1 ? '{sid}' : '{counter}'))}`;

  /**
   * One node under the channel, streamed by REST (`Accept: text/event-stream`)
   * with the phone's ID token, kept as a copy that `until` waits on.
   *
   * @param {string} relative
   */
  function followNode(relative) {
    const { channelId } = requirePairing();
    if (!idToken) throw new Error('the phone holds no token');
    const what = `the phone's stream of ${nodeName(relative)}`;
    const controller = new AbortController();
    /** @type {unknown} */
    let tree = null;
    let live = false;
    /** @type {Error|null} */
    let failure = null;
    /** @type {Set<() => void>} */
    const waiters = new Set();
    const wake = () => { for (const waiter of waiters) waiter(); };
    (async () => {
      const response = await fetchImpl(databaseNodeUrl(databaseUrl, `channels/${channelId}/${relative}`, idToken), {
        headers: { Accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        let body;
        try { body = JSON.parse(await response.text()); } catch { body = null; }
        throw new RelayAnswer(what, response.status, reasonOf(body));
      }
      await readEventStream(response.body, ({ type, data }) => {
        if (type === 'put' || type === 'patch') {
          const change = JSON.parse(data);
          tree = applyAt(tree, change.path, change.data, type === 'patch');
          live = true;
        } else if (type === 'cancel' || type === 'auth_revoked') {
          failure = new RelayAnswer(what, 200, type);
        }
        wake();
      }, { maxEventChars: 1024 * 1024 });
      if (!controller.signal.aborted) failure ??= new RelayAnswer(what, 200, 'the stream ended');
      wake();
    })().catch((error) => {
      if (controller.signal.aborted) return;
      failure = error instanceof RelayAnswer ? error : new RelayAnswer(what, null, 'no connection');
      wake();
    });
    return {
      get value() { return tree; },
      /**
       * The node's value once `predicate` holds for it.
       * @param {(value: any) => boolean} predicate
       * @param {string} expected  what the wait is for, for the message
       */
      until(predicate, expected) {
        return new Promise((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            waiters.delete(check);
          };
          const check = () => {
            if (live && predicate(tree)) {
              done();
              resolve(tree);
            } else if (failure) {
              done();
              reject(failure);
            }
          };
          const timer = setTimeout(() => {
            done();
            reject(new RelayAnswer(what, 200, `${expected} did not show within ${waitMs} ms`));
          }, waitMs);
          waiters.add(check);
          check();
        });
      },
      close: () => controller.abort(),
    };
  }

  /** @param {string} relative */
  function stream(relative) {
    const found = streams.get(relative);
    if (!found) throw new Error('the phone has not connected');
    return found;
  }

  /**
   * One write under the channel, silent (`print=silent`) as the desktop's are:
   * `{ status }`, whatever the database answered. `null` deletes.
   *
   * @param {string} relative
   * @param {unknown} value
   */
  async function writeNode(relative, value) {
    const { channelId } = requirePairing();
    if (!idToken) throw new Error('the phone holds no token');
    const url = new URL(databaseNodeUrl(databaseUrl, `channels/${channelId}/${relative}`, idToken));
    url.searchParams.set('print', 'silent');
    const method = value === null ? 'DELETE' : 'PUT';
    const answer = await exchange(fetchImpl, `${method} ${nodeName(relative)}.json`, url.href, {
      method, body: value === null ? undefined : value, timeoutMs,
    });
    return { status: answer.status, reason: reasonOf(answer.body) };
  }

  /**
   * The same write, which has to succeed.
   * @param {string} relative
   * @param {unknown} value
   */
  async function put(relative, value) {
    const { status, reason } = await writeNode(relative, value);
    if (status !== 200 && status !== 204) throw new RelayAnswer(`${value === null ? 'DELETE' : 'PUT'} ${nodeName(relative)}.json`, status, reason);
  }

  function requireSession() {
    if (!session) throw new Error('the phone has no session');
    return session;
  }

  const phone = {
    /** The phone's key bundle, as it goes into the channel. */
    keys: keys.bundle,

    /** Steps 15–16: the typed key, read as the phone reads it — `{ error }` before anything is sent. */
    parseCode: (/** @type {string} */ typed) => ref.parseCode(typed),

    challenge,
    signIn,

    /**
     * Steps 17–18 (§5.4). Without App Check when `appCheck` is false — to see the relay refuse it.
     * @param {string} typedKey
     * @param {{ appCheck?: boolean }} [options]
     */
    async lookup(typedKey, { appCheck = true } = {}) {
      const parsed = ref.parseCode(typedKey);
      if (parsed.error) throw new Error(`the phone refuses the code: ${parsed.error}`);
      const answer = await relay('GET', `/pairings/${parsed.pairingId}`, { appCheck });
      const { channelId, desktopKeys, expiresAt } = answer ?? {};
      if (typeof channelId !== 'string' || fromB64u(channelId).length !== 16
        || !desktopKeys || typeof desktopKeys.sign !== 'string' || typeof desktopKeys.agree !== 'string'
        || typeof expiresAt !== 'number') {
        throw new RelayAnswer('GET /pairings/{pairingId}', 200, 'not a pairing');
      }
      pairing = { code: parsed.code, pairingId: parsed.pairingId, channelId, desktopKeys: { sign: desktopKeys.sign, agree: desktopKeys.agree } };
      return { channelId, desktopKeys: pairing.desktopKeys, expiresAt };
    },

    /**
     * Steps 19–22 (§5.5): `MAC_P` over the keys, a proof over a fresh
     * challenge, then the custom token for role `phone` as an ID token.
     * `sign` replaces the phone's own signer — a proof that must not verify;
     * `expect` is the status a refusal has to come with.
     *
     * @param {{ sign?: (message: Uint8Array) => Buffer, expect?: number }} [options]
     */
    async claim({ sign = keys.sign, expect = 200 } = {}) {
      const { code, pairingId, channelId, desktopKeys } = requirePairing();
      const desktopPoints = { sign: fromB64u(desktopKeys.sign), agree: fromB64u(desktopKeys.agree) };
      const macP = b64u(ref.macPhone(code, fromB64u(channelId), desktopPoints, keys.points));
      const text = await challenge();
      const proof = b64u(sign(ref.claimMessage(fromB64u(text), fromB64u(channelId), keys.points)));
      const answer = await relay('POST', `/pairings/${pairingId}/claim`, {
        appCheck: true,
        body: { challenge: text, phoneKeys: keys.bundle, macP, proof },
        expect,
      });
      if (expect !== 200) return { channelId };
      if (answer?.channelId !== channelId) throw new RelayAnswer('POST /pairings/{pairingId}/claim', 200, 'another channel');
      idToken = await signIn(answer.token);
      return { channelId };
    },

    /** The six words the phone shows (step 28). */
    words() {
      const { desktopKeys } = requirePairing();
      const desktopPoints = { sign: fromB64u(desktopKeys.sign), agree: fromB64u(desktopKeys.agree) };
      return ref.phraseWords(ref.phraseIndices(desktopPoints, keys.points).indices);
    },

    /**
     * Step 37: `paired`, and a `MAC_D` that the phone can check with the code.
     * @param {unknown} meta  what the phone read of `meta`
     */
    acceptsPairing(meta) {
      const { code, channelId, desktopKeys } = requirePairing();
      if (!meta || typeof meta !== 'object') return false;
      const { status, macD } = /** @type {{ status?: unknown, macD?: unknown }} */ (meta);
      if (status !== 'paired' || typeof macD !== 'string') return false;
      const desktopPoints = { sign: fromB64u(desktopKeys.sign), agree: fromB64u(desktopKeys.agree) };
      const expected = ref.macDesktop(code, fromB64u(channelId), desktopPoints, keys.points);
      const given = fromB64u(macD);
      return given.length === expected.length && nodeCrypto.timingSafeEqual(expected, given);
    },

    /**
     * A node under the phone's channel, through the database's REST interface
     * with the phone's ID token: `{ status, value }` — 200 with the value, or
     * the database's refusal.
     *
     * @param {string} [relative]  under `/channels/{channelId}`; the channel node itself when empty
     */
    async read(relative = '') {
      const { channelId } = requirePairing();
      if (!idToken) throw new Error('the phone holds no token');
      const nodePath = relative ? `channels/${channelId}/${relative}` : `channels/${channelId}`;
      const what = `GET /${relative ? `channels/{channelId}/${relative}` : 'channels/{channelId}'}.json`;
      const answer = await exchange(fetchImpl, what, databaseNodeUrl(databaseUrl, nodePath, idToken), { timeoutMs });
      return { status: answer.status, value: answer.body };
    },

    /**
     * §5.9 for role `phone`: a fresh token, which then replaces the one from the claim.
     * @param {{ expect?: number }} [options]
     */
    async refreshToken({ expect = 200 } = {}) {
      const { channelId } = requirePairing();
      const text = await challenge();
      const proof = b64u(keys.sign(ref.tokenMessage(fromB64u(text), fromB64u(channelId), 'phone')));
      const answer = await relay('POST', '/tokens', { body: { challenge: text, channelId, role: 'phone', proof }, expect });
      if (expect === 200) idToken = await signIn(answer?.token);
    },

    /**
     * A call the phone's role may not make: confirm the channel itself (§5.6 is the desktop's).
     * @param {{ expect?: number }} [options]
     */
    async confirmAsPhone({ expect = 403 } = {}) {
      const { channelId } = requirePairing();
      await relay('POST', `/channels/${channelId}/confirm`, { body: { macD: b64u(Buffer.alloc(32)) }, bearer: idToken, expect });
    },

    /**
     * *Disconnect* on the phone (§5.8).
     * @param {{ expect?: number }} [options]
     */
    async disconnect({ expect = 204 } = {}) {
      const { channelId } = requirePairing();
      await relay('DELETE', `/channels/${channelId}`, { bearer: idToken, expect });
    },

    /**
     * Any call, for the refusals that have no method of their own.
     * @param {string} method
     * @param {string} route
     * @param {{ body?: unknown, rawBody?: string, appCheck?: boolean, expect?: number }} [options]
     */
    call: (method, route, options) => relay(method, route, options),

    // ---------------------------------------------------------------- part 2

    /**
     * A write under the channel that may be refused — for the rules: `{ status, reason }`.
     * `null` deletes.
     */
    write: writeNode,

    /**
     * §12 steps 1 and 2: a fresh token, then the four nodes the phone follows.
     * Resolves once each stream has delivered its first value.
     */
    async connect() {
      await phone.refreshToken();
      phone.closeStreams();
      for (const node of PHONE_NODES) streams.set(node, followNode(node));
      await Promise.all(PHONE_NODES.map((node) => stream(node).until(() => true, 'a first value')));
    },

    /** The phone's copy of a node it follows. */
    stream,

    /** Stops following; the session's keys stay. */
    closeStreams() {
      for (const follower of streams.values()) follower.close();
      streams.clear();
    },

    /** §12.3: the phone's presence record, stamped by the server — or gone, as `onDisconnect` would leave it. */
    setPresence: () => put('presence/phone', { online: true, since: SERVER_TIME }),
    clearPresence: () => put('presence/phone', null),

    /**
     * Handshake 1 (§13): a fresh X25519 key and the versions on offer.
     * @param {{ offered?: number[], ephemeral?: Buffer }} [options]  `ephemeral` the raw private key, fixed in a test
     */
    async offer({ offered = [1], ephemeral = nodeCrypto.randomBytes(32) } = {}) {
      const publicKey = channelRef.x25519Public(ephemeral);
      // A desktop that answers the same twice writes nothing new; what counts
      // is an answer that differs from the one there before.
      offer = { ephemeral, publicKey, offered: [...offered], before: JSON.stringify(stream('handshake/desktop').value) };
      session = null;
      await put('handshake/phone', { v: offered, e: b64u(publicKey) });
      return { e: b64u(publicKey) };
    },

    /**
     * Handshake 2 (§13) and the session keys (§14): `{ v, sid }` for a
     * session, `{ error, v }` for a version nobody shares.
     */
    async answer() {
      if (!offer) throw new Error('the phone has offered no handshake');
      const { ephemeral, publicKey, offered, before } = offer;
      const record = await stream('handshake/desktop').until(
        (value) => value !== null && JSON.stringify(value) !== before,
        'the desktop\'s answer to handshake 1',
      );
      offer = null;
      if (record.error !== undefined) {
        if (record.error !== 'protocol-unsupported' || !Array.isArray(record.v)) {
          throw new RelayAnswer('handshake 2', 200, `not an answer: ${JSON.stringify(record)}`);
        }
        return { error: record.error, v: record.v };
      }
      const desktopEphemeral = typeof record.e === 'string' ? fromB64u(record.e) : Buffer.alloc(0);
      if (!offered.includes(record.v) || desktopEphemeral.length !== 32) {
        throw new RelayAnswer('handshake 2', 200, `not an answer to ${JSON.stringify(offered)}: ${JSON.stringify(record)}`);
      }
      const { channelId, desktopKeys } = requirePairing();
      const desktopPoints = { sign: fromB64u(desktopKeys.sign), agree: fromB64u(desktopKeys.agree) };
      const ss = keys.agree(desktopKeys.agree);
      const ee = channelRef.x25519Shared(ephemeral, desktopEphemeral);
      const th = channelRef.transcriptHash({
        channelId: fromB64u(channelId),
        desktopKeys: desktopPoints,
        phoneKeys: keys.points,
        offered,
        phoneEphemeral: publicKey,
        chosen: record.v,
        desktopEphemeral,
      });
      const derived = channelRef.sessionKeys(ss, ee, th);
      session = { toDesktop: derived.toDesktop, toPhone: derived.toPhone, sid: Buffer.from(derived.sid), next: 0, out: 0 };
      return { v: record.v, sid: session.sid.toString('hex') };
    },

    /** The session's id, 16 hex digits — or null. */
    sid: () => (session ? session.sid.toString('hex') : null),

    /**
     * One envelope to the desktop (§15): the next counter, sealed with
     * `k_to-desktop`. `tamper` flips a bit of the tag.
     *
     * @param {unknown} message  JSON-RPC, or a string sent as it is
     * @param {{ tamper?: boolean }} [options]
     */
    async send(message, { tamper = false } = {}) {
      const s = requireSession();
      const counter = s.out;
      s.out += 1;
      const plaintext = typeof message === 'string' ? message : JSON.stringify(message);
      const sealed = channelRef.seal(s.toDesktop, s.sid, channelRef.DIRECTION.toDesktop, counter, plaintext);
      if (tamper) sealed[sealed.length - 1] ^= 1;
      const path = `to-desktop/${s.sid.toString('hex')}/${hex16(counter)}`;
      await put(path, { c: b64u(sealed), at: SERVER_TIME });
      return { counter, path, record: { c: b64u(sealed), at: SERVER_TIME } };
    },

    /**
     * The desktop's next envelope (§15, §16), opened with `k_to-phone` and
     * deleted once read; the message as JSON.
     */
    async receive() {
      const s = requireSession();
      const sid = s.sid.toString('hex');
      const key = hex16(s.next);
      const inbox = await stream('to-phone').until((tree) => typeof tree?.[sid]?.[key]?.c === 'string', `envelope ${s.next} of the session`);
      const plaintext = channelRef.open(s.toPhone, s.sid, channelRef.DIRECTION.toPhone, s.next, fromB64u(inbox[sid][key].c));
      if (plaintext === null) throw new RelayAnswer(`envelope ${s.next} from the desktop`, 200, 'it does not open (§15)');
      s.next += 1;
      await put(`to-phone/${sid}/${key}`, null);
      try {
        return JSON.parse(plaintext);
      } catch {
        throw new RelayAnswer(`envelope ${s.next - 1} from the desktop`, 200, 'not JSON (§17)');
      }
    },

    /**
     * A JSON-RPC request and its answer (§17).
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     */
    async request(method, params = {}) {
      requests += 1;
      const id = `ref-${requests}`;
      await phone.send({ jsonrpc: '2.0', id, method, params });
      const reply = await phone.receive();
      if (reply?.jsonrpc !== '2.0' || reply.id !== id) throw new RelayAnswer(`the answer to ${method}`, 200, `another message: ${JSON.stringify(reply)}`);
      return reply;
    },
  };
  return phone;
}

module.exports = { createReferencePhone, createKeys, databaseNodeUrl, hex16, RelayAnswer, SERVER_TIME };
