'use strict';

/**
 * A stand-in for the relay of the mobile remote (#1135) over real HTTP, so
 * that the reference phone and the conformance runner can run here without
 * the Firebase emulator. The real relay lives in snotra-promotion (#165) and
 * is held to the same runner in that repository's CI.
 *
 * It serves, on one local port:
 *
 * - the relay's endpoints of docs/remote-protocol.md §5 under `/v1`;
 * - the Identity Toolkit's `accounts:signInWithCustomToken` under `/identitytoolkit/v1`;
 * - the Realtime Database's REST interface under `/db`, reads only, with the
 *   read rules of §5.10 and §12 and REST streaming for `meta`. Its URL carries
 *   `?ns=`, as the emulator's does, so that clients keep the database's query.
 *
 * Its proofs are checked with the bridge's protocol code; the reference phone
 * computes them with scripts/remote-protocol-vectors.js. It is no model of
 * Firebase beyond what part 1 of the protocol needs.
 *
 * `faults` breaks one promise of the spec on purpose, so that a test can see
 * the runner notice it.
 */

const http = require('node:http');
const nodeCrypto = require('node:crypto');
const protocol = require('../../src/main/remote/pairing-protocol');

const MAX_BODY_BYTES = 4096;
const CHALLENGE_TTL_MS = 60_000;
const PAIRING_TTL_MS = 5 * 60_000;
const NAMESPACE = 'stand-in';

/** The faults a test can switch on. */
const FAULTS = Object.freeze({
  /** A pairing takes a second claim, and the second phone's keys replace the first's. */
  SECOND_CLAIM: 'second-claim',
  /** The phone may read its inbox before the channel is `paired`. */
  EARLY_INBOX: 'early-inbox',
});

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} reason
   */
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

const invalid = () => new HttpError(400, 'invalid-request');
const unauthorized = () => new HttpError(401, 'unauthorized');
const refused = () => new HttpError(403, 'refused');
const notFound = () => new HttpError(404, 'not-found');

/**
 * @param {{ apiKey?: string, appCheckToken?: string, faults?: string[], now?: () => number }} [options]
 */
function createRelayStandIn({
  apiKey = 'stand-in-api-key',
  appCheckToken = 'stand-in-app-check',
  faults = [],
  now = () => Date.now(),
} = {}) {
  const broken = new Set(faults);
  /** @type {Map<string, number>} challenge → expiresAt */
  const challenges = new Map();
  /** @type {Map<string, { channelId: string, expiresAt: number, claimed: boolean }>} */
  const pairings = new Map();
  /** @type {Map<string, { meta: Record<string, unknown> }>} */
  const channels = new Map();
  /** @type {Map<string, { ch: string, role: string }>} custom token → claims */
  const customTokens = new Map();
  /** @type {Map<string, { ch: string, role: string }>} ID token → claims */
  const idTokens = new Map();
  /** @type {Map<string, Set<(meta: Record<string, unknown> | null) => void>>} channelId → meta listeners */
  const listeners = new Map();
  /** @type {Set<http.ServerResponse>} */
  const streams = new Set();

  const token = () => nodeCrypto.randomBytes(24).toString('base64url');

  /** @param {string} channelId */
  function changed(channelId) {
    const meta = channels.get(channelId)?.meta ?? null;
    for (const listener of listeners.get(channelId) ?? []) listener(meta && structuredClone(meta));
  }

  function sweep() {
    for (const [challenge, expiresAt] of challenges) if (now() > expiresAt) challenges.delete(challenge);
    for (const [pairingId, pairing] of pairings) {
      if (now() <= pairing.expiresAt) continue;
      pairings.delete(pairingId);
      if (channels.get(pairing.channelId)?.meta.status !== 'paired') dropChannel(pairing.channelId);
    }
  }

  /** @param {string} channelId */
  function dropChannel(channelId) {
    if (!channels.delete(channelId)) return false;
    for (const [pairingId, pairing] of pairings) if (pairing.channelId === channelId) pairings.delete(pairingId);
    // ID tokens stay valid until they expire, as Firebase's do: a token for a
    // deleted channel still authenticates, and finds nothing.
    changed(channelId);
    return true;
  }

  /** @param {unknown} text */
  function takeChallenge(text) {
    if (typeof text !== 'string') throw invalid();
    const expiresAt = challenges.get(text);
    challenges.delete(text);
    if (expiresAt === undefined || now() > expiresAt) throw refused();
    return protocol.fromB64u(text);
  }

  /** @param {unknown} keys */
  function keysOf(keys) {
    if (!protocol.isKeyBundle(keys)) throw invalid();
    const { sign, agree } = /** @type {{ sign: string, agree: string }} */ (keys);
    return { sign, agree };
  }

  /**
   * @param {string} point
   * @param {Uint8Array} message
   * @param {unknown} proof
   */
  function requireProof(point, message, proof) {
    const signature = protocol.fromB64u(proof, 64);
    if (!signature || !protocol.verifySignature(point, message, signature)) throw refused();
  }

  /** @param {http.IncomingMessage} req */
  function caller(req) {
    const header = req.headers.authorization ?? '';
    const claims = header.startsWith('Bearer ') ? idTokens.get(header.slice(7)) : undefined;
    if (!claims) throw unauthorized();
    return claims;
  }

  /** @param {http.IncomingMessage} req */
  function requireAppCheck(req) {
    if (req.headers['x-firebase-appcheck'] !== appCheckToken) throw unauthorized();
  }

  /**
   * @param {string} channelId
   * @param {string} role
   */
  function customToken(channelId, role) {
    const value = token();
    customTokens.set(value, { ch: channelId, role });
    return value;
  }

  /** @param {string} id */
  function channelIdOf(id) {
    if (!protocol.fromB64u(id, protocol.CHANNEL_ID_BYTES)) throw invalid();
    return id;
  }

  // ------------------------------------------------------------ §5 endpoints

  /**
   * @param {http.IncomingMessage} req
   * @param {string} method
   * @param {string[]} parts  the path after `/v1`
   * @param {any} body
   * @returns {[number, unknown?]}
   */
  function endpoint(req, method, parts, body) {
    const [first, id, action] = parts;
    if (method === 'POST' && first === 'challenges' && parts.length === 1) {
      const challenge = protocol.toB64u(nodeCrypto.randomBytes(32));
      const expiresAt = now() + CHALLENGE_TTL_MS;
      challenges.set(challenge, expiresAt);
      return [200, { challenge, expiresAt }];
    }

    if (method === 'POST' && first === 'pairings' && parts.length === 1) {
      const challenge = takeChallenge(body.challenge);
      const desktopKeys = keysOf(body.desktopKeys);
      requireProof(desktopKeys.sign, protocol.openMessage(challenge, desktopKeys), body.proof);
      const channelId = protocol.toB64u(nodeCrypto.randomBytes(protocol.CHANNEL_ID_BYTES));
      let pairingId;
      do {
        const value = nodeCrypto.randomBytes(3).readUIntBE(0, 3) & 0xfffff;
        pairingId = [15, 10, 5, 0].map((shift) => protocol.ALPHABET[(value >> shift) & 31]).join('');
      } while (pairings.has(pairingId));
      const expiresAt = now() + PAIRING_TTL_MS;
      channels.set(channelId, { meta: { desktopKeys, status: 'open', createdAt: now(), lastSeen: now() } });
      pairings.set(pairingId, { channelId, expiresAt, claimed: false });
      return [201, { channelId, pairingId, expiresAt, token: customToken(channelId, 'desktop') }];
    }

    if (first === 'pairings' && id && parts.length <= 3) {
      if (!new RegExp(`^[${protocol.ALPHABET}]{4}$`).test(id)) throw invalid();
      const pairing = pairings.get(id);
      const live = pairing && now() <= pairing.expiresAt && (!pairing.claimed || broken.has(FAULTS.SECOND_CLAIM));

      if (method === 'GET' && parts.length === 2) {
        requireAppCheck(req);
        if (!live || pairing.claimed) throw notFound();
        const { meta } = /** @type {{ meta: any }} */ (channels.get(pairing.channelId));
        return [200, { channelId: pairing.channelId, desktopKeys: meta.desktopKeys, expiresAt: pairing.expiresAt }];
      }

      if (method === 'POST' && action === 'claim') {
        requireAppCheck(req);
        const challenge = takeChallenge(body.challenge);
        const phoneKeys = keysOf(body.phoneKeys);
        if (!protocol.fromB64u(body.macP, protocol.MAC_BYTES)) throw invalid();
        if (!live) throw notFound();
        requireProof(phoneKeys.sign, protocol.claimMessage(challenge, pairing.channelId, phoneKeys), body.proof);
        const channel = channels.get(pairing.channelId);
        if (!channel) throw notFound();
        Object.assign(channel.meta, { phoneKeys, macP: body.macP, status: 'pending', lastSeen: now() });
        pairing.claimed = true;
        changed(pairing.channelId);
        return [200, { channelId: pairing.channelId, token: customToken(pairing.channelId, 'phone') }];
      }

      if (method === 'DELETE' && parts.length === 2) {
        const who = caller(req);
        if (who.role !== 'desktop') throw refused();
        if (pairing && pairing.channelId === who.ch) {
          pairings.delete(id);
          if (channels.get(who.ch)?.meta.status !== 'paired') dropChannel(who.ch);
        }
        return [204];
      }
    }

    if (first === 'channels' && id) {
      const channelId = channelIdOf(id);
      if (method === 'POST' && action === 'confirm' && parts.length === 3) {
        const who = caller(req);
        if (who.role !== 'desktop' || who.ch !== channelId) throw refused();
        if (!protocol.fromB64u(body.macD, protocol.MAC_BYTES)) throw invalid();
        const channel = channels.get(channelId);
        if (!channel) throw notFound();
        if (channel.meta.status !== 'pending') throw new HttpError(409, 'busy');
        Object.assign(channel.meta, { macD: body.macD, status: 'paired', lastSeen: now() });
        for (const [pairingId, pairing] of pairings) if (pairing.channelId === channelId) pairings.delete(pairingId);
        changed(channelId);
        return [204];
      }
      if (method === 'DELETE' && parts.length === 2) {
        const who = caller(req);
        if (who.ch !== channelId) throw refused();
        if (!dropChannel(channelId)) throw notFound();
        return [204];
      }
    }

    if (method === 'POST' && first === 'tokens' && parts.length === 1) {
      const challenge = takeChallenge(body.challenge);
      const { role } = body;
      if (role !== 'desktop' && role !== 'phone') throw invalid();
      const channelId = channelIdOf(String(body.channelId));
      const meta = /** @type {any} */ (channels.get(channelId)?.meta);
      if (!meta) throw notFound();
      const keys = meta[`${role}Keys`];
      if (!keys || (role === 'phone' && meta.status !== 'paired')) throw refused();
      requireProof(keys.sign, protocol.tokenMessage(challenge, channelId, role), body.proof);
      meta.lastSeen = now();
      return [200, { token: customToken(channelId, role) }];
    }

    throw notFound();
  }

  // ------------------------------------------------------------ the database

  /**
   * The read rules of §5.10 and §12: `meta` for both sides, each side's own
   * inbox and the other side's handshake and presence — for the phone only
   * once the channel is `paired` — and never the channel node itself.
   *
   * @param {{ ch: string, role: string }} claims
   * @param {string[]} parts
   */
  function mayRead(claims, parts) {
    if (parts[0] !== 'channels' || parts[1] !== claims.ch || parts.length < 3) return false;
    const node = parts.slice(2, 4).join('/');
    if (parts[2] === 'meta') return true;
    if (claims.role === 'desktop') return ['to-desktop', 'handshake/phone', 'presence/phone'].some((n) => node.startsWith(n));
    const status = channels.get(claims.ch)?.meta.status;
    if (status !== 'paired' && !broken.has(FAULTS.EARLY_INBOX)) return false;
    return ['to-phone', 'handshake/desktop', 'presence/desktop'].some((n) => node.startsWith(n));
  }

  /** @param {string[]} parts */
  function valueAt(parts) {
    /** @type {unknown} */
    let node = channels.get(parts[1]) ?? null;
    for (const part of parts.slice(2)) {
      node = node && typeof node === 'object' ? /** @type {Record<string, unknown>} */ (node)[part] ?? null : null;
    }
    return node === null ? null : structuredClone(node);
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {URL} url
   */
  function database(req, res, url) {
    if (url.searchParams.get('ns') !== NAMESPACE) return send(res, 404, { error: 'Namespace not found' });
    if (req.method !== 'GET' || !url.pathname.endsWith('.json')) return send(res, 405, { error: 'Read only' });
    const parts = url.pathname.slice('/db/'.length, -'.json'.length).split('/').filter(Boolean);
    const claims = idTokens.get(url.searchParams.get('auth') ?? '');
    if (!claims || !mayRead(claims, parts)) return send(res, 401, { error: 'Permission denied' });

    if (!String(req.headers.accept).includes('text/event-stream')) return send(res, 200, valueAt(parts));
    if (parts.length !== 3 || parts[2] !== 'meta') return send(res, 400, { error: 'The stand-in streams meta only' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    streams.add(res);
    const put = (/** @type {unknown} */ data) => res.write(`event: put\ndata: ${JSON.stringify({ path: '/', data })}\n\n`);
    put(valueAt(parts));
    let set = listeners.get(parts[1]);
    if (!set) listeners.set(parts[1], set = new Set());
    set.add(put);
    res.on('close', () => {
      set.delete(put);
      streams.delete(res);
    });
  }

  /**
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {unknown} [body]
   */
  function send(res, status, body) {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  }

  /**
   * @param {http.IncomingMessage} req
   * @returns {Promise<any>}
   */
  async function readBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) throw new HttpError(413, 'too-large');
      chunks.push(chunk);
    }
    if (total === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
      return parsed;
    } catch {
      throw invalid();
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stand-in');
    try {
      sweep();
      if (url.pathname.startsWith('/db/')) return database(req, res, url);
      if (url.pathname === '/identitytoolkit/v1/accounts:signInWithCustomToken' && req.method === 'POST') {
        const body = await readBody(req);
        if (url.searchParams.get('key') !== apiKey) return send(res, 400, { error: { message: 'API key not valid' } });
        const claims = customTokens.get(body.token);
        if (!claims) return send(res, 400, { error: { message: 'INVALID_CUSTOM_TOKEN' } });
        customTokens.delete(body.token);
        const idToken = token();
        idTokens.set(idToken, claims);
        return send(res, 200, { idToken, refreshToken: token(), expiresIn: '3600' });
      }
      if (url.pathname.startsWith('/v1/')) {
        const body = await readBody(req);
        const [status, answer] = endpoint(req, req.method ?? 'GET', url.pathname.slice(4).split('/').filter(Boolean), body);
        return send(res, status, answer);
      }
      return send(res, 404, { error: { reason: 'not-found' } });
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: { reason: error.reason } });
      return send(res, 503, { error: { reason: 'unavailable' } });
    }
  });

  return {
    /** Listens on a free local port; answers the configuration the runner takes. */
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const base = `http://127.0.0.1:${port}`;
      return {
        relayHost: `127.0.0.1:${port}`,
        relayUrl: `${base}/v1`,
        databaseUrl: `${base}/db?ns=${NAMESPACE}`,
        apiKey,
        identityToolkitUrl: `${base}/identitytoolkit/v1`,
        appCheckToken,
      };
    },
    async stop() {
      for (const res of streams) res.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
    /** What is left on the relay, for a test to look at. */
    inspect: () => ({ channels: channels.size, pairings: pairings.size, streams: streams.size }),
  };
}

module.exports = { createRelayStandIn, FAULTS };
