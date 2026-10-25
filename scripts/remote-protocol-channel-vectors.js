'use strict';
/**
 * Reference implementation of the channel in docs/remote/remote-protocol.md, part 2
 * (#1113) — handshake, session keys, encrypted envelopes, the receiver's
 * order rule — and the generator of its test vectors,
 * docs/remote/remote-protocol/channel-v1.json.
 *
 * Builds on part 1 (scripts/remote-protocol-vectors.js): the long-term keys
 * and the channel id of the pairing vectors are the input here. Like part 1
 * it pins bytes; the bridge (#1114) and the iPhone app implement the same
 * functions on their own. test/remote-protocol-channel-vectors.test.js keeps
 * this file, the vectors and the spec in step.
 *
 *   node scripts/remote-protocol-channel-vectors.js    rewrites the vector file
 *
 * Everything here is deterministic — ChaCha20-Poly1305 with a counter nonce
 * has no randomness — so the whole file is compared, not only verified.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pairing = require('./remote-protocol-vectors');

const { lp, keyBundle } = pairing;
const VECTOR_FILE = path.join(__dirname, '..', 'docs', 'remote', 'remote-protocol', 'channel-v1.json');

const LABEL = Object.freeze({
  handshake: 'snotra/v1 handshake',
  session: 'snotra/v1 session',
  envelope: 'snotra/v1 envelope',
});

const DIRECTION = Object.freeze({ toDesktop: 'to-desktop', toPhone: 'to-phone' });

/** How far ahead of the next expected counter an envelope may arrive and still be held. */
const HOLD_WINDOW = 32;
/** Plaintext limit of one envelope: one JSON-RPC message, UTF-8. */
const MAX_PLAINTEXT_BYTES = 256 * 1024;

function sha256(...parts) {
  return crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
}

function u64(n) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(n));
  return out;
}

// ---------------------------------------------------------------- keys

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function x25519PrivateKey(raw) {
  return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

/** The 32-byte public key of a raw X25519 private key (CryptoKit's `rawRepresentation`). */
function x25519Public(raw) {
  return Buffer.from(crypto.createPublicKey(x25519PrivateKey(raw)).export({ format: 'jwk' }).x, 'base64url');
}

function x25519Shared(privateRaw, publicRaw) {
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicRaw.toString('base64url') }, format: 'jwk' });
  return crypto.diffieHellman({ privateKey: x25519PrivateKey(privateRaw), publicKey });
}

/** P-256 ECDH of the long-term agree keys: the shared point's x-coordinate, 32 bytes. */
function staticShared(agreePrivateScalar, otherAgreePoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(agreePrivateScalar);
  return ecdh.computeSecret(otherAgreePoint);
}

// ---------------------------------------------------------------- handshake

/**
 * The transcript hash both sides compute after handshake 2:
 * `SHA-256(lp(label) ‖ lp(channelId) ‖ KB_D ‖ KB_P ‖ lp(offered) ‖ lp(e_P) ‖ u8(chosen) ‖ lp(e_D))`,
 * `offered` one byte per protocol version the phone speaks.
 */
function transcriptHash({ channelId, desktopKeys, phoneKeys, offered, phoneEphemeral, chosen, desktopEphemeral }) {
  return sha256(
    lp(LABEL.handshake),
    lp(channelId),
    keyBundle(desktopKeys),
    keyBundle(phoneKeys),
    lp(Buffer.from(offered)),
    lp(phoneEphemeral),
    Buffer.from([chosen]),
    lp(desktopEphemeral),
  );
}

/** One key per direction from `HKDF-SHA256(ss ‖ ee, salt = th, info = lp(label))`; the session id is `th[0..8]`. */
function sessionKeys(ss, ee, th) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([ss, ee]), th, lp(LABEL.session), 64));
  return { toDesktop: okm.subarray(0, 32), toPhone: okm.subarray(32, 64), sid: th.subarray(0, 8) };
}

/** What the desktop answers to handshake 1: its choice, or the versions it speaks. */
function chooseVersion(offered, spoken = [1]) {
  const shared = offered.filter((v) => spoken.includes(v));
  return shared.length ? { v: Math.max(...shared) } : { error: 'protocol-unsupported', v: spoken };
}

// ---------------------------------------------------------------- envelopes

/** `0x00000000 ‖ u64be(counter)` — 96 bits, unique per key because each session and direction has its own. */
function nonce(counter) {
  return Buffer.concat([Buffer.alloc(4), u64(counter)]);
}

/** `lp(label) ‖ lp(sid) ‖ lp(direction) ‖ u64be(counter)` — binds the ciphertext to its place. */
function aad(sid, direction, counter) {
  return Buffer.concat([lp(LABEL.envelope), lp(sid), lp(direction), u64(counter)]);
}

function envelopePath(channelId, direction, sid, counter) {
  return `/channels/${channelId.toString('base64url')}/${direction}/${sid.toString('hex')}/${u64(counter).toString('hex')}`;
}

function seal(key, sid, direction, counter, plaintext) {
  const body = Buffer.from(plaintext, 'utf8');
  if (body.length > MAX_PLAINTEXT_BYTES) throw new RangeError('envelope plaintext over the limit');
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: 16 });
  cipher.setAAD(aad(sid, direction, counter), { plaintextLength: body.length });
  return Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
}

/** Returns the plaintext, or `null` when the envelope does not authenticate. */
function open(key, sid, direction, counter, sealed) {
  if (sealed.length < 16) return null;
  const body = sealed.subarray(0, -16);
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: 16 });
  decipher.setAAD(aad(sid, direction, counter), { plaintextLength: body.length });
  decipher.setAuthTag(sealed.subarray(-16));
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * The receiver's order rule, as a pure function over the counters in the
 * order they arrive: deliver the next one, hold up to HOLD_WINDOW ahead,
 * drop what was seen, and start a new handshake when a counter is further
 * ahead than the window (or a held gap is not filled in time — not modelled).
 */
function receiveOrder(arrivals) {
  let next = 0;
  const held = new Set();
  const seen = new Set();
  const actions = [];
  for (const counter of arrivals) {
    if (counter < next || held.has(counter) || seen.has(counter)) {
      actions.push({ counter, action: 'drop' });
      continue;
    }
    if (counter > next + HOLD_WINDOW) {
      actions.push({ counter, action: 'rehandshake' });
      break;
    }
    if (counter > next) {
      held.add(counter);
      actions.push({ counter, action: 'hold' });
      continue;
    }
    const delivered = [counter];
    seen.add(counter);
    next += 1;
    while (held.has(next)) {
      held.delete(next);
      seen.add(next);
      delivered.push(next);
      next += 1;
    }
    actions.push({ counter, action: 'deliver', delivered });
  }
  return actions;
}

// ---------------------------------------------------------------- the vectors

function fixedInputs() {
  const p = pairing.readVectors();
  const point = (s) => Buffer.from(s, 'base64url');
  return {
    pairingVectors: p,
    channelId: Buffer.from(p.channelId, 'base64url'),
    desktopKeys: { sign: point(p.desktop.keys.sign), agree: point(p.desktop.keys.agree) },
    phoneKeys: { sign: point(p.phone.keys.sign), agree: point(p.phone.keys.agree) },
    desktopAgreePrivate: Buffer.from(p.desktop.agreePrivate, 'hex'),
    phoneAgreePrivate: Buffer.from(p.phone.agreePrivate, 'hex'),
    desktopEphemeral: sha256(Buffer.from('snotra test desktop ephemeral')),
    phoneEphemeral: sha256(Buffer.from('snotra test phone ephemeral')),
  };
}

/** Four messages, two each way, as the first minutes of a connection would carry them. */
const MESSAGES = [
  {
    direction: DIRECTION.toDesktop,
    counter: 0,
    message: { jsonrpc: '2.0', id: 1, method: 'session.hello', params: { protocol: [1], client: { name: 'Snotra mobile', version: '1.0.0' }, capabilities: ['approvals'] } },
  },
  {
    direction: DIRECTION.toPhone,
    counter: 0,
    message: {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocol: 1,
        connectionId: 'q8Xv0w3J7mH2bVt5kQ9RzA',
        kind: 'relay',
        app: { version: '1.26.0' },
        methods: ['session.hello', 'workspaces.list', 'chats.list', 'chat.open', 'message.send', 'run.abort', 'approval.respond'],
        approvalResponses: ['allow-once', 'deny'],
        limits: { maxRequestBytes: 262144, maxTextChars: 100000, maxConnections: 4, eventBufferSeconds: 60 },
      },
    },
  },
  {
    direction: DIRECTION.toPhone,
    counter: 1,
    message: { jsonrpc: '2.0', method: 'chat.delta', params: { chatId: 'c-7f3a', runId: 'r-19', text: 'Größe geprüft – passt.' } },
  },
  {
    direction: DIRECTION.toDesktop,
    counter: 1,
    message: { jsonrpc: '2.0', id: 2, method: 'approval.respond', params: { requestId: 'a-42', response: 'allow-once' } },
  },
];

function buildVectors() {
  const input = fixedInputs();
  const offered = [1];
  const phoneE = x25519Public(input.phoneEphemeral);
  const desktopE = x25519Public(input.desktopEphemeral);
  const handshake1 = { v: offered, e: phoneE.toString('base64url') };
  const answer = chooseVersion(offered);
  const handshake2 = { v: answer.v, e: desktopE.toString('base64url') };

  const ssDesktop = staticShared(input.desktopAgreePrivate, input.phoneKeys.agree);
  const ssPhone = staticShared(input.phoneAgreePrivate, input.desktopKeys.agree);
  if (!ssDesktop.equals(ssPhone)) throw new Error('static agreement differs between the sides');
  const eeDesktop = x25519Shared(input.desktopEphemeral, phoneE);
  const eePhone = x25519Shared(input.phoneEphemeral, desktopE);
  if (!eeDesktop.equals(eePhone)) throw new Error('ephemeral agreement differs between the sides');

  const th = transcriptHash({
    channelId: input.channelId,
    desktopKeys: input.desktopKeys,
    phoneKeys: input.phoneKeys,
    offered,
    phoneEphemeral: phoneE,
    chosen: handshake2.v,
    desktopEphemeral: desktopE,
  });
  const keys = sessionKeys(ssDesktop, eeDesktop, th);
  const keyFor = (direction) => (direction === DIRECTION.toDesktop ? keys.toDesktop : keys.toPhone);

  const envelopes = MESSAGES.map(({ direction, counter, message }) => {
    const plaintext = JSON.stringify(message);
    const sealed = seal(keyFor(direction), keys.sid, direction, counter, plaintext);
    return {
      direction,
      counter,
      path: envelopePath(input.channelId, direction, keys.sid, counter),
      nonce: nonce(counter).toString('hex'),
      aad: aad(keys.sid, direction, counter).toString('hex'),
      plaintext,
      record: { c: sealed.toString('base64url'), at: { '.sv': 'timestamp' } },
    };
  });

  const first = envelopes[0];
  const flipped = Buffer.from(first.record.c, 'base64url');
  flipped[0] ^= 0x01;

  const arrivals = [0, 2, 1, 1, 3, 40];

  return {
    protocol: 1,
    part: 'channel',
    spec: 'docs/remote/remote-protocol.md',
    generatedBy: 'node scripts/remote-protocol-channel-vectors.js',
    uses: 'docs/remote/remote-protocol/pairing-v1.json — the long-term keys and the channel id',
    note: 'Deterministic: the file is compared as a whole. Hex for bytes that are only hashed or authenticated, base64url where the value travels in JSON.',
    labels: LABEL,
    ephemeral: {
      desktop: { private: input.desktopEphemeral.toString('hex'), public: desktopE.toString('base64url') },
      phone: { private: input.phoneEphemeral.toString('hex'), public: phoneE.toString('base64url') },
    },
    handshake1: { path: `/channels/${input.channelId.toString('base64url')}/handshake/phone`, record: handshake1 },
    handshake2: { path: `/channels/${input.channelId.toString('base64url')}/handshake/desktop`, record: handshake2 },
    versionMismatch: { offered: [2], answer: chooseVersion([2]) },
    staticShared: ssDesktop.toString('hex'),
    ephemeralShared: eeDesktop.toString('hex'),
    transcriptHash: th.toString('hex'),
    sid: keys.sid.toString('hex'),
    keys: { toDesktop: keys.toDesktop.toString('hex'), toPhone: keys.toPhone.toString('hex') },
    envelopes,
    tampered: { path: first.path, record: { c: flipped.toString('base64url') }, expect: 'reject' },
    order: { holdWindow: HOLD_WINDOW, arrivals, actions: receiveOrder(arrivals) },
  };
}

function readVectors() {
  return JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(VECTOR_FILE), { recursive: true });
  fs.writeFileSync(VECTOR_FILE, `${JSON.stringify(buildVectors(), null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), VECTOR_FILE)}`);
}

module.exports = {
  DIRECTION,
  HOLD_WINDOW,
  LABEL,
  MAX_PLAINTEXT_BYTES,
  VECTOR_FILE,
  aad,
  buildVectors,
  chooseVersion,
  envelopePath,
  nonce,
  open,
  readVectors,
  receiveOrder,
  seal,
  sessionKeys,
  staticShared,
  transcriptHash,
  x25519Public,
  x25519Shared,
};
