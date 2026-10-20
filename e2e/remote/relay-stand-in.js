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
 * - the Realtime Database's REST interface under `/db`: reads, writes and
 *   deletes under a channel with the rules of §5.10, §12, §13 and §15 — the
 *   same conditions as snotra-promotion's `relay/database.rules.json` — the
 *   server's timestamp, and REST streaming of any node a side may read. Its
 *   URL carries `?ns=`, as the emulator's does, so that clients keep the
 *   database's query.
 *
 * Its proofs are checked with the bridge's protocol code; the reference phone
 * computes them with scripts/remote-protocol-vectors.js. It is no model of
 * Firebase beyond what the protocol needs.
 *
 * `faults` breaks one promise of the spec on purpose, so that a test can see
 * the runner notice it.
 */

const http = require('node:http');
const nodeCrypto = require('node:crypto');
const protocol = require('../../src/main/remote/pairing-protocol');

const MAX_BODY_BYTES = 4096;
/** The database takes more than the endpoints: an envelope carries up to 256 KiB (§15). */
const MAX_DATABASE_BODY_BYTES = 512 * 1024;
const CHALLENGE_TTL_MS = 60_000;
const PAIRING_TTL_MS = 5 * 60_000;
const NAMESPACE = 'stand-in';
const HEX16 = /^[0-9a-f]{16}$/;
const EPHEMERAL = /^[A-Za-z0-9_-]{43}$/;
const SEALED = /^[A-Za-z0-9_-]+$/;
/** b64u of the smallest and the largest sealed envelope: 1 byte plus tag, 256 KiB plus tag. */
const SEALED_MIN_CHARS = 23;
const SEALED_MAX_CHARS = 349_547;

/** The faults a test can switch on. */
const FAULTS = Object.freeze({
  /** A pairing takes a second claim, and the second phone's keys replace the first's. */
  SECOND_CLAIM: 'second-claim',
  /** The phone may read its inbox before the channel is `paired`. */
  EARLY_INBOX: 'early-inbox',
  /** A sender may overwrite an envelope it wrote before. */
  OVERWRITE_ENVELOPE: 'overwrite-envelope',
});

/** @param {unknown} value */
const isTree = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value  the placeholder for the server's time, which the rules compare with `now` */
const isServerTime = (value) => isTree(value) && Object.keys(/** @type {object} */ (value)).length === 1
  && /** @type {Record<string, unknown>} */ (value)['.sv'] === 'timestamp';

/**
 * @param {unknown} value
 * @param {string[]} required
 * @param {Record<string, (child: unknown) => boolean>} children  every child allowed, and its check
 */
function shaped(value, required, children) {
  if (!isTree(value)) return false;
  const tree = /** @type {Record<string, unknown>} */ (value);
  if (!required.every((key) => key in tree)) return false;
  return Object.entries(tree).every(([key, child]) => children[key]?.(child) === true);
}

/** @param {unknown} v  a protocol version (§13) */
const isVersion = (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 1 && /** @type {number} */ (v) <= 255;
/** @param {unknown} list  at most ten versions, as the rules' `$index` allows */
const isVersionList = (list) => Array.isArray(list) && list.length > 0 && list.length <= 10 && list.every(isVersion);
/** @param {unknown} e */
const isEphemeral = (e) => typeof e === 'string' && EPHEMERAL.test(e);

/** What each record of part 2 may hold — the `.validate` rules of the relay. */
const VALID = Object.freeze({
  /** @param {unknown} value */
  envelope: (value) => shaped(value, ['c', 'at'], {
    c: (c) => typeof c === 'string' && c.length >= SEALED_MIN_CHARS && c.length <= SEALED_MAX_CHARS && SEALED.test(c),
    at: isServerTime,
  }),
  /** @param {unknown} value */
  phoneHandshake: (value) => shaped(value, ['v', 'e'], { v: isVersionList, e: isEphemeral }),
  /** @param {unknown} value */
  desktopHandshake: (value) => shaped(value, ['v', 'e'], { v: isVersion, e: isEphemeral })
    || shaped(value, ['v', 'error'], { v: isVersionList, error: (error) => error === 'protocol-unsupported' }),
  /** @param {unknown} value */
  desktopPresence: (value) => shaped(value, ['lastSeen'], { lastSeen: isServerTime }),
  /** @param {unknown} value */
  phonePresence: (value) => shaped(value, ['online', 'since'], { online: (online) => online === true, since: isServerTime }),
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
  /** Each channel's tree: `meta`, the relay's, and the nodes of part 2, the clients'. */
  /** @type {Map<string, { meta: Record<string, unknown>, [node: string]: unknown }>} */
  const channels = new Map();
  /** @type {Map<string, { ch: string, role: string }>} custom token → claims */
  const customTokens = new Map();
  /** @type {Map<string, { ch: string, role: string }>} ID token → claims */
  const idTokens = new Map();
  /**
   * The open streams: who follows which node, and what it was sent last.
   * @type {Set<{ res: http.ServerResponse, claims: { ch: string, role: string }, parts: string[], last: string }>}
   */
  const streams = new Set();

  const token = () => nodeCrypto.randomBytes(24).toString('base64url');

  /**
   * Tells every stream of the channel what changed under its node, in the
   * order the streams were opened. A stream whose read the rules no longer
   * allow gets `cancel` and ends, as the database's does.
   *
   * @param {string} channelId
   */
  function changed(channelId) {
    for (const follower of streams) {
      if (follower.parts[1] !== channelId) continue;
      if (!mayRead(follower.claims, follower.parts)) {
        follower.res.end('event: cancel\ndata: null\n\n');
        streams.delete(follower);
        continue;
      }
      const text = JSON.stringify(valueAt(follower.parts));
      if (text === follower.last) continue;
      follower.last = text;
      follower.res.write(`event: put\ndata: ${JSON.stringify({ path: '/', data: JSON.parse(text) })}\n\n`);
    }
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

  /** The sides' own nodes of part 2: who writes them, who reads them. */
  const OWN_NODES = Object.freeze({
    desktop: Object.freeze({ inbox: 'to-desktop', outbox: 'to-phone', other: 'phone' }),
    phone: Object.freeze({ inbox: 'to-phone', outbox: 'to-desktop', other: 'desktop' }),
  });

  /** @param {string} channelId */
  const isPaired = (channelId) => channels.get(channelId)?.meta.status === 'paired';

  /**
   * The read rules of §5.10 and §12: `meta` for both sides; each side's own
   * inbox and the other side's handshake and presence, once the channel is
   * `paired`; never the channel node itself.
   *
   * @param {{ ch: string, role: string }} claims
   * @param {string[]} parts
   */
  function mayRead(claims, parts) {
    if (parts[0] !== 'channels' || parts[1] !== claims.ch || parts.length < 3) return false;
    if (parts[2] === 'meta') return true;
    const own = OWN_NODES[/** @type {'desktop'|'phone'} */ (claims.role)];
    if (!own) return false;
    if (!isPaired(claims.ch) && !(claims.role === 'phone' && broken.has(FAULTS.EARLY_INBOX))) return false;
    if (parts[2] === own.inbox) return true;
    return (parts[2] === 'handshake' || parts[2] === 'presence') && parts[3] === own.other;
  }

  /**
   * The write rules of §12, §13 and §15, with what each record may hold. A
   * write of `null` deletes; the rules' `.validate` does not apply to it.
   *
   * @param {{ ch: string, role: string }} claims
   * @param {string[]} parts
   * @param {unknown} value
   */
  function mayWrite(claims, parts, value) {
    if (parts[0] !== 'channels' || parts[1] !== claims.ch || !isPaired(claims.ch)) return false;
    const own = OWN_NODES[/** @type {'desktop'|'phone'} */ (claims.role)];
    if (!own) return false;
    const [, , node, sid, counter, ...deeper] = parts;
    if (deeper.length) return false;
    const deleting = value === null;
    if ((node === 'handshake' || node === 'presence') && counter === undefined) {
      if (sid !== claims.role) return false;
      if (deleting) return true;
      if (node === 'presence') return claims.role === 'desktop' ? VALID.desktopPresence(value) : VALID.phonePresence(value);
      return claims.role === 'desktop' ? VALID.desktopHandshake(value) : VALID.phoneHandshake(value);
    }
    if (node === own.inbox) {
      // The receiver deletes what it handled, or a whole ended session.
      return deleting && sid !== undefined;
    }
    if (node === own.outbox && sid !== undefined && counter !== undefined) {
      // The sender creates, once, and never overwrites or deletes.
      if (deleting || !HEX16.test(sid) || !HEX16.test(counter)) return false;
      const exists = valueAt(parts) !== null;
      if (exists && !broken.has(FAULTS.OVERWRITE_ENVELOPE)) return false;
      return VALID.envelope(value);
    }
    return false;
  }

  /** @param {string[]} parts */
  function valueAt(parts) {
    /** @type {unknown} */
    let node = channels.get(parts[1]) ?? null;
    for (const part of parts.slice(2)) {
      node = isTree(node) ? /** @type {Record<string, unknown>} */ (node)[part] ?? null : null;
    }
    return node === null ? null : structuredClone(node);
  }

  /**
   * The server's time in place of its placeholder.
   * @param {unknown} value
   * @returns {unknown}
   */
  function resolve(value) {
    if (isServerTime(value)) return now();
    if (Array.isArray(value)) return value.map(resolve);
    if (!isTree(value)) return value;
    return Object.fromEntries(Object.entries(/** @type {object} */ (value)).map(([key, child]) => [key, resolve(child)]));
  }

  /**
   * Sets a node under the channel; `null` deletes it, and parents left empty go with it.
   * @param {string[]} parts
   * @param {unknown} value
   */
  function setAt(parts, value) {
    const channel = /** @type {Record<string, unknown>} */ (channels.get(parts[1]));
    /** @type {Array<[Record<string, unknown>, string]>} */
    const trail = [];
    let node = channel;
    for (const part of parts.slice(2, -1)) {
      if (!isTree(node[part])) {
        if (value === null) return;
        node[part] = {};
      }
      trail.push([node, part]);
      node = /** @type {Record<string, unknown>} */ (node[part]);
    }
    const last = /** @type {string} */ (parts.at(-1));
    if (value === null) delete node[last];
    else node[last] = value;
    for (const [parent, key] of trail.reverse()) {
      const child = /** @type {Record<string, unknown>} */ (parent[key]);
      if (Object.keys(child).length === 0) delete parent[key];
    }
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {URL} url
   */
  async function database(req, res, url) {
    if (url.searchParams.get('ns') !== NAMESPACE) return send(res, 404, { error: 'Namespace not found' });
    if (!url.pathname.endsWith('.json')) return send(res, 400, { error: 'Not a node' });
    const parts = url.pathname.slice('/db/'.length, -'.json'.length).split('/').filter(Boolean);
    const claims = idTokens.get(url.searchParams.get('auth') ?? '');

    if (req.method === 'PUT' || req.method === 'DELETE') {
      const value = req.method === 'DELETE' ? null : await readBody(req, { limit: MAX_DATABASE_BODY_BYTES, anyJson: true });
      if (!claims || !channels.has(parts[1] ?? '') || !mayWrite(claims, parts, value)) return send(res, 401, { error: 'Permission denied' });
      const stored = resolve(value);
      setAt(parts, stored);
      changed(parts[1]);
      return url.searchParams.get('print') === 'silent' ? send(res, 204) : send(res, 200, stored);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Not supported by the stand-in' });
    if (!claims || !mayRead(claims, parts)) return send(res, 401, { error: 'Permission denied' });

    if (!String(req.headers.accept).includes('text/event-stream')) return send(res, 200, valueAt(parts));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const text = JSON.stringify(valueAt(parts));
    const follower = { res, claims, parts, last: text };
    streams.add(follower);
    res.write(`event: put\ndata: ${JSON.stringify({ path: '/', data: JSON.parse(text) })}\n\n`);
    res.on('close', () => streams.delete(follower));
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
   * @param {{ limit?: number, anyJson?: boolean }} [options]  `anyJson` takes any JSON value, as the database does
   * @returns {Promise<any>}
   */
  async function readBody(req, { limit = MAX_BODY_BYTES, anyJson = false } = {}) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) throw new HttpError(413, 'too-large');
      chunks.push(chunk);
    }
    if (total === 0) return anyJson ? null : {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!anyJson && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw invalid();
      return parsed;
    } catch {
      throw invalid();
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stand-in');
    try {
      sweep();
      if (url.pathname.startsWith('/db/')) return await database(req, res, url);
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
      for (const { res } of streams) res.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
    /** What is left on the relay, for a test to look at. */
    inspect: () => ({ channels: channels.size, pairings: pairings.size, streams: streams.size }),
  };
}

module.exports = { createRelayStandIn, FAULTS };
