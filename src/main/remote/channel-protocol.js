'use strict';

/**
 * The desktop's computations for docs/remote-protocol.md part 2 (#1192): the
 * answer to a handshake (§13), the session keys (§14), the envelopes (§15).
 *
 * Node's built-in `crypto` only — X25519, P-256 ECDH, HKDF-SHA256 and
 * ChaCha20-Poly1305 are all in OpenSSL. Proven byte for byte against
 * docs/remote-protocol/channel-v1.json, which the reference implementation
 * in scripts/remote-protocol-channel-vectors.js writes; the two are written
 * apart on purpose, as the iPhone app will be a third.
 *
 * Key bytes stay in here: the ephemeral private key is a `KeyObject` that
 * goes out of scope once the keys are derived, and the session keys sit in a
 * closure whose `forget()` overwrites them.
 */

const nodeCrypto = require('node:crypto');
const { lp, fromB64u, toB64u, keyBundleBytes } = require('./pairing-protocol');

const LABELS = Object.freeze({
  handshake: 'snotra/v1 handshake',
  session: 'snotra/v1 session',
  envelope: 'snotra/v1 envelope',
});

const DIRECTIONS = Object.freeze({ TO_DESKTOP: 'to-desktop', TO_PHONE: 'to-phone' });

const EPHEMERAL_BYTES = 32;
const KEY_BYTES = 32;
const SID_BYTES = 8;
const TAG_BYTES = 16;
/** One JSON-RPC message per envelope, UTF-8 (§15). */
const MAX_PLAINTEXT_BYTES = 256 * 1024;

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** @param {number} n */
function u64(n) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(n));
  return out;
}

/**
 * A counter as it names an envelope: 16 hex digits, so that the keys sort as numbers (§15).
 * @param {number} counter
 */
function counterKey(counter) {
  return u64(counter).toString('hex');
}

/** @param {number} counter */
function nonce(counter) {
  return Buffer.concat([Buffer.alloc(4), u64(counter)]);
}

/**
 * `lp(label) ‖ lp(sid) ‖ lp(direction) ‖ u64be(counter)`.
 * @param {Buffer} sid
 * @param {string} direction
 * @param {number} counter
 */
function associatedData(sid, direction, counter) {
  return Buffer.concat([lp(LABELS.envelope), lp(sid), lp(direction), u64(counter)]);
}

/** @param {unknown} value */
function isEphemeralKey(value) {
  return !!fromB64u(value, EPHEMERAL_BYTES);
}

/** @param {Buffer} raw  32 bytes */
function x25519PrivateKey(raw) {
  return nodeCrypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

/** @param {Buffer} raw  32 bytes */
function x25519PublicKey(raw) {
  return nodeCrypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: toB64u(raw) }, format: 'jwk' });
}

/** @param {import('node:crypto').KeyObject} key */
function rawPublic(key) {
  const x = fromB64u(key.export({ format: 'jwk' }).x, EPHEMERAL_BYTES);
  if (!x) throw new Error('remote channel: the public half of an ephemeral key could not be read');
  return x;
}

/**
 * `SHA-256(lp(label) ‖ lp(channelId) ‖ KB_D ‖ KB_P ‖ lp(offered) ‖ lp(e_P) ‖ u8(chosen) ‖ lp(e_D))` (§14).
 *
 * @param {{ channelId: Buffer, desktopKeys: unknown, phoneKeys: unknown, offered: number[],
 *   phoneEphemeral: Buffer, chosen: number, desktopEphemeral: Buffer }} input
 */
function transcriptHash({ channelId, desktopKeys, phoneKeys, offered, phoneEphemeral, chosen, desktopEphemeral }) {
  return nodeCrypto.createHash('sha256').update(Buffer.concat([
    lp(LABELS.handshake),
    lp(channelId),
    keyBundleBytes(desktopKeys),
    keyBundleBytes(phoneKeys),
    lp(Buffer.from(offered)),
    lp(phoneEphemeral),
    Buffer.from([chosen]),
    lp(desktopEphemeral),
  ])).digest();
}

/**
 * `HKDF-SHA256(ikm = ss ‖ ee, salt = th, info = lp(label), L = 64)` → both keys; `sid = th[0..8]`.
 * @param {Uint8Array} ss
 * @param {Uint8Array} ee
 * @param {Buffer} th
 */
function deriveKeys(ss, ee, th) {
  const okm = Buffer.from(nodeCrypto.hkdfSync('sha256', Buffer.concat([ss, ee]), th, lp(LABELS.session), 2 * KEY_BYTES));
  return { toDesktop: okm.subarray(0, KEY_BYTES), toPhone: okm.subarray(KEY_BYTES), sid: Buffer.from(th.subarray(0, SID_BYTES)) };
}

/**
 * @param {Buffer} key
 * @param {Buffer} sid
 * @param {string} direction
 * @param {number} counter
 * @param {string} plaintext
 */
function sealEnvelope(key, sid, direction, counter, plaintext) {
  const body = Buffer.from(plaintext, 'utf8');
  if (body.length > MAX_PLAINTEXT_BYTES) throw new RangeError('remote channel: envelope plaintext over the limit');
  const cipher = nodeCrypto.createCipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(sid, direction, counter), { plaintextLength: body.length });
  return toB64u(Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]));
}

/**
 * The plaintext, or null for anything that does not authenticate — a bad tag,
 * a malformed record, a body that is no UTF-8.
 *
 * @param {Buffer} key
 * @param {Buffer} sid
 * @param {string} direction
 * @param {number} counter
 * @param {unknown} sealed  base64url
 */
function openEnvelope(key, sid, direction, counter, sealed) {
  const bytes = fromB64u(sealed);
  if (!bytes || bytes.length < TAG_BYTES || bytes.length > MAX_PLAINTEXT_BYTES + TAG_BYTES) return null;
  const body = bytes.subarray(0, bytes.length - TAG_BYTES);
  try {
    const decipher = nodeCrypto.createDecipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(sid, direction, counter), { plaintextLength: body.length });
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    // A tag that does not verify is the answer "no", not an error.
    return null;
  }
}

/**
 * The desktop's half of a session: seals `to-phone`, opens `to-desktop`.
 * @param {{ toDesktop: Buffer, toPhone: Buffer, sid: Buffer }} keys
 * @returns {import('../../application/ports/remote-channel-crypto-port').RemoteChannelSession}
 */
function desktopSession(keys) {
  /** @type {{ toDesktop: Buffer, toPhone: Buffer } | null} */
  let held = { toDesktop: keys.toDesktop, toPhone: keys.toPhone };
  const sid = keys.sid;
  const live = () => {
    if (!held) throw new Error('remote channel: the session has ended');
    return held;
  };
  return Object.freeze({
    sid: sid.toString('hex'),
    seal: (counter, plaintext) => sealEnvelope(live().toPhone, sid, DIRECTIONS.TO_PHONE, counter, plaintext),
    open: (counter, sealed) => openEnvelope(live().toDesktop, sid, DIRECTIONS.TO_DESKTOP, counter, sealed),
    forget() {
      if (!held) return;
      held.toDesktop.fill(0);
      held.toPhone.fill(0);
      held = null;
    },
  });
}

/**
 * @param {{ randomBytes?: (size: number) => Uint8Array }} [deps]  `randomBytes` draws the ephemeral private key — fixed in the vector test
 * @returns {import('../../application/ports/remote-channel-crypto-port').RemoteChannelCryptoPort}
 */
function createRemoteChannelCryptoAdapter({ randomBytes = nodeCrypto.randomBytes } = {}) {
  return {
    isEphemeralKey,
    answerHandshake({ channelId, desktopKeys, phoneKeys, offered, chosen, phoneEphemeral, agree }) {
      const channelBytes = fromB64u(channelId);
      const phoneE = fromB64u(phoneEphemeral, EPHEMERAL_BYTES);
      if (!channelBytes || !phoneE) throw new TypeError('remote channel: not a handshake');
      const own = x25519PrivateKey(Buffer.from(randomBytes(EPHEMERAL_BYTES)));
      const desktopE = rawPublic(nodeCrypto.createPublicKey(own));
      // OpenSSL refuses a low-order point, whose agreement would be all zeros.
      const ee = nodeCrypto.diffieHellman({ privateKey: own, publicKey: x25519PublicKey(phoneE) });
      const ss = Buffer.from(agree(phoneKeys.agree));
      const th = transcriptHash({
        channelId: channelBytes, desktopKeys, phoneKeys, offered, phoneEphemeral: phoneE, chosen, desktopEphemeral: desktopE,
      });
      const keys = deriveKeys(ss, ee, th);
      ss.fill(0);
      ee.fill(0);
      return { desktopEphemeral: toB64u(desktopE), session: desktopSession(keys) };
    },
  };
}

module.exports = {
  DIRECTIONS,
  LABELS,
  MAX_PLAINTEXT_BYTES,
  associatedData,
  counterKey,
  createRemoteChannelCryptoAdapter,
  isEphemeralKey,
  nonce,
  transcriptHash,
};
