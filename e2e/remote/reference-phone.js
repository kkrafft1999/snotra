'use strict';

/**
 * The reference phone of the mobile remote (#1135, phase 3 of #1081): the
 * phone's half of docs/remote-protocol.md part 1 over the relay's real
 * interface — HTTP to the relay's endpoints, the Identity Toolkit for an ID
 * token, the Realtime Database's REST interface for what the phone may read.
 *
 * It computes what it sends with the reference implementation in
 * scripts/remote-protocol-vectors.js, not with the bridge's code in
 * src/main/remote/: what the phone sends and what the desktop checks come from
 * two implementations, as they will with the iPhone app. It needs nothing but
 * this repository and Node 24 — `node:crypto` and `fetch`.
 *
 * Every call answers or throws a RelayAnswer with the HTTP status and the
 * relay's `reason`. Tokens stay in this object: no error, no message and no
 * return value carries one, since snotra-promotion's CI prints what fails.
 */

const nodeCrypto = require('node:crypto');
const ref = require('../../scripts/remote-protocol-vectors');

const REQUEST_TIMEOUT_MS = 15_000;

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
  return {
    points,
    bundle: { sign: b64u(points.sign), agree: b64u(points.agree) },
    sign: (/** @type {Uint8Array} */ message) => nodeCrypto.sign('sha256', message, { key: pairs.sign.privateKey, dsaEncoding: 'ieee-p1363' }),
  };
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
 * @param {RelayConfig & { fetchImpl?: typeof fetch, timeoutMs?: number }} config
 */
function createReferencePhone({
  relayUrl,
  databaseUrl,
  apiKey,
  identityToolkitUrl = 'https://identitytoolkit.googleapis.com/v1',
  appCheckToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const keys = createKeys();
  /** @type {string|null} */
  let idToken = null;
  /** What the phone learned while pairing: the code, the channel, the desktop's keys. */
  /** @type {{ code: string, pairingId: string, channelId: string, desktopKeys: { sign: string, agree: string } } | null} */
  let pairing = null;

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
  };
  return phone;
}

module.exports = { createReferencePhone, createKeys, databaseNodeUrl, RelayAnswer };
