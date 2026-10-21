'use strict';

/**
 * The bytes of docs/remote-protocol.md part 1 as the desktop computes them
 * (#1114): the pairing code (§4), the proofs for the relay (§5), `MAC_P` and
 * `MAC_D` (§6) and the safety phrase (§7).
 *
 * Written from the specification, not from scripts/remote-protocol-vectors.js:
 * the two implementations meet only in docs/remote-protocol/pairing-v1.json
 * (test/remote-pairing-protocol.test.js), and that is what makes the vectors a
 * check of this file. The iPhone app proves its own against the same file.
 *
 * Values that travel in JSON are base64url strings here; what is only hashed,
 * signed or MACed is a Buffer. A malformed input makes a function return
 * `false` or `null` or throw a plain `TypeError` — never one whose message
 * quotes the input, which may be a key or a MAC.
 */

/** @typedef {import('../../application/ports/remote-relay-port').RemoteKeyBundle} RemoteKeyBundle */
/** @typedef {import('../../application/ports/remote-pairing-crypto-port').RemoteClaimInput} RemoteClaimInput */

const nodeCrypto = require('node:crypto');
const SAFETY_WORDS = require('../../shared/contracts/remote/safety-words-v1.json').words;
const { isRecord } = require('../../shared/runtime/is-record');

/** Crockford's base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIRING_ID_SYMBOLS = 4;
const SECRET_SYMBOLS = 15;
const CODE_SYMBOLS = PAIRING_ID_SYMBOLS + SECRET_SYMBOLS + 1;
const SECRET_BITS = SECRET_SYMBOLS * 5;
const PHRASE_WORDS = 6;

const POINT_BYTES = 65;
const CHANNEL_ID_BYTES = 16;
const MAC_BYTES = 32;
const SIGNATURE_BYTES = 64;
const MAX_CHALLENGE_BYTES = 64;

const LABELS = Object.freeze({
  codeCheck: 'snotra/v1 code-check',
  pairOpen: 'snotra/v1 pair-open',
  pairClaim: 'snotra/v1 pair-claim',
  token: 'snotra/v1 token',
  macPhone: 'snotra/v1 mac phone',
  macDesktop: 'snotra/v1 mac desktop',
  phrase: 'snotra/v1 phrase',
});

const ROLES = Object.freeze({ DESKTOP: 'desktop', PHONE: 'phone' });

const PAIRING_ID = new RegExp(`^[${ALPHABET}]{${PAIRING_ID_SYMBOLS}}$`);
const CANONICAL_CODE = new RegExp(`^[${ALPHABET}]{${CODE_SYMBOLS}}$`);
const BASE64URL = /^[A-Za-z0-9_-]*$/;

// ---------------------------------------------------------------- encodings

/**
 * `lp(x) = u16be(len(x)) ‖ x` (§2).
 * @param {string | Uint8Array} value
 */
function lp(value) {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (body.length > 0xffff) throw new TypeError('lp: input longer than 65535 bytes');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length);
  return Buffer.concat([head, body]);
}

/**
 * base64url without padding (§2).
 * @param {Uint8Array} bytes
 */
function toB64u(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Reads base64url strictly: only its alphabet, no padding, and only the
 * canonical spelling — so one value has one string, and a relay cannot slip a
 * second spelling of an id past a comparison.
 *
 * @param {unknown} text
 * @param {number} [length]  the byte length it must have
 * @returns {Buffer|null}
 */
function fromB64u(text, length) {
  if (typeof text !== 'string' || !BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return null;
  if (length !== undefined && bytes.length !== length) return null;
  return bytes;
}

/** @param {...Buffer} parts */
function sha256(...parts) {
  return nodeCrypto.createHash('sha256').update(Buffer.concat(parts)).digest();
}

/**
 * @param {Buffer} key
 * @param {...Buffer} parts
 */
function hmacSha256(key, ...parts) {
  return nodeCrypto.createHmac('sha256', key).update(Buffer.concat(parts)).digest();
}

// ---------------------------------------------------------------- keys (§3)

/**
 * The public key behind an uncompressed SEC1 point, or null when it is none on P-256.
 * @param {unknown} point
 */
function publicKeyOf(point) {
  if (!Buffer.isBuffer(point) || point.length !== POINT_BYTES || point[0] !== 0x04) return null;
  try {
    return nodeCrypto.createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
    });
  } catch {
    // Not a point on the curve: the answer is "no key", not an error.
    return null;
  }
}

/**
 * @param {unknown} keys
 * @returns {{ sign: Buffer, agree: Buffer } | null}
 */
function bundlePoints(keys) {
  if (!isRecord(keys)) return null;
  const sign = fromB64u(keys.sign, POINT_BYTES);
  const agree = fromB64u(keys.agree, POINT_BYTES);
  return sign && agree ? { sign, agree } : null;
}

/**
 * Two valid uncompressed P-256 points, as base64url.
 * @param {unknown} keys
 * @returns {keys is RemoteKeyBundle}
 */
function isKeyBundle(keys) {
  const points = bundlePoints(keys);
  return !!points && !!publicKeyOf(points.sign) && !!publicKeyOf(points.agree);
}

/**
 * `KB = lp(sign) ‖ lp(agree)` (§3).
 * @param {unknown} keys
 */
function keyBundleBytes(keys) {
  const points = bundlePoints(keys);
  if (!points) throw new TypeError('not a key bundle');
  return Buffer.concat([lp(points.sign), lp(points.agree)]);
}

/**
 * ECDSA P-256 / SHA-256 in IEEE P1363 form, checked against a base64url point.
 * @param {unknown} pointB64u
 * @param {Uint8Array} message
 * @param {unknown} signature
 */
function verifySignature(pointB64u, message, signature) {
  const key = publicKeyOf(fromB64u(pointB64u, POINT_BYTES));
  if (!key || !Buffer.isBuffer(signature) || signature.length !== SIGNATURE_BYTES) return false;
  return nodeCrypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature);
}

// ---------------------------------------------------------------- the pairing code (§4)

/**
 * @param {bigint} value
 * @param {number} count
 */
function encodeSymbols(value, count) {
  let rest = BigInt(value);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out = ALPHABET[Number(rest & 31n)] + out;
    rest >>= 5n;
  }
  if (rest !== 0n) throw new TypeError('value does not fit the symbols');
  return out;
}

/**
 * The top five bits of `SHA-256(lp(label) ‖ ascii(first 19 symbols))`, as a symbol.
 * @param {string} body
 */
function checkSymbol(body) {
  return ALPHABET[sha256(lp(LABELS.codeCheck), Buffer.from(body, 'ascii'))[0] >> 3];
}

/**
 * The code from the relay's pairing id and a secret of 75 bits.
 *
 * @param {string} pairingId  four symbols
 * @param {bigint} secret
 */
function makeCode(pairingId, secret) {
  if (typeof pairingId !== 'string' || !PAIRING_ID.test(pairingId)) throw new TypeError('not a pairing id');
  if (typeof secret !== 'bigint' || secret < 0n || secret >= 1n << BigInt(SECRET_BITS)) {
    throw new TypeError('not a 75-bit secret');
  }
  const body = pairingId + encodeSymbols(secret, SECRET_SYMBOLS);
  return body + checkSymbol(body);
}

/**
 * 75 bits from the CSPRNG: ten bytes, the lowest five bits dropped.
 *
 * @param {(size: number) => Uint8Array} [randomBytes]
 */
function drawSecret(randomBytes = nodeCrypto.randomBytes) {
  const bytes = randomBytes(10);
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`) >> 5n;
}

/**
 * `0111-EP9D-ZH4Q-PYT4-HWWF`
 * @param {string} code
 */
function displayCode(code) {
  return (code.match(/.{4}/g) ?? []).join('-');
}

/**
 * @param {string} relayHost
 * @param {string} code
 */
function qrPayload(relayHost, code) {
  return `snotra-pair:v1/${relayHost}/${code}`;
}

/** @param {unknown} code */
function isCanonicalCode(code) {
  return typeof code === 'string' && CANONICAL_CODE.test(code) && checkSymbol(code.slice(0, -1)) === code.slice(-1);
}

// ---------------------------------------------------------------- MACs (§6)

/**
 * `T = lp(channelId) ‖ KB_D ‖ KB_P`, the channel id as its 16 raw bytes.
 * @param {unknown} channelId
 * @param {unknown} desktopKeys
 * @param {unknown} phoneKeys
 */
function transcript(channelId, desktopKeys, phoneKeys) {
  const id = fromB64u(channelId, CHANNEL_ID_BYTES);
  if (!id) throw new TypeError('not a channel id');
  return Buffer.concat([lp(id), keyBundleBytes(desktopKeys), keyBundleBytes(phoneKeys)]);
}

/**
 * @param {string} label
 * @param {RemoteClaimInput} input
 */
function pairingMac(label, { code, channelId, desktopKeys, phoneKeys }) {
  if (!isCanonicalCode(code)) throw new TypeError('not a pairing code');
  return hmacSha256(Buffer.from(code, 'ascii'), lp(label), transcript(channelId, desktopKeys, phoneKeys));
}

/** @param {RemoteClaimInput} input */
function phoneMac(input) {
  return pairingMac(LABELS.macPhone, input);
}

/** @param {RemoteClaimInput} input */
function desktopMac(input) {
  return pairingMac(LABELS.macDesktop, input);
}

/**
 * `MAC_P` as it came from the relay, compared in constant time.
 * @param {(RemoteClaimInput & { macP?: unknown }) | null | undefined} input
 */
function verifyPhoneMac(input) {
  const given = fromB64u(input?.macP, MAC_BYTES);
  if (!input || !given) return false;
  let expected;
  try {
    expected = phoneMac(input);
  } catch {
    // Keys or an id of the wrong shape: no MAC can match them.
    return false;
  }
  return nodeCrypto.timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------- the safety phrase (§7)

/**
 * `H0 = SHA-256(lp(label) ‖ KB_D ‖ KB_P)`, `H(i+1) = SHA-256(H(i))`, read as
 * 16-bit big-endian values; a value below `floor(65536 / N) · N` gives the
/** @typedef {{ hash0: Buffer, values: number[], indices: number[] }} PhraseIndices */

/**
 * `H0 = SHA-256(lp(label) ‖ KB_D ‖ KB_P)`, `H(i+1) = SHA-256(H(i))`, read as
 * 16-bit big-endian values; a value below `floor(65536 / N) · N` gives the
 * index `value mod N`, any other is skipped.
 *
 * @param {unknown} desktopKeys
 * @param {unknown} phoneKeys
 * @param {number} [listSize]
 * @returns {PhraseIndices}
 */
function phraseIndices(desktopKeys, phoneKeys, listSize = SAFETY_WORDS.length) {
  const bound = Math.floor(65536 / listSize) * listSize;
  const hash0 = sha256(lp(LABELS.phrase), keyBundleBytes(desktopKeys), keyBundleBytes(phoneKeys));
  /** @type {number[]} */
  const values = [];
  /** @type {number[]} */
  const indices = [];
  for (let block = hash0; indices.length < PHRASE_WORDS; block = sha256(block)) {
    for (let at = 0; at < block.length && indices.length < PHRASE_WORDS; at += 2) {
      const value = block.readUInt16BE(at);
      values.push(value);
      if (value < bound) indices.push(value % listSize);
    }
  }
  return { hash0, values, indices };
}

/**
 * @param {unknown} desktopKeys
 * @param {unknown} phoneKeys
 */
function phrase(desktopKeys, phoneKeys) {
  return phraseIndices(desktopKeys, phoneKeys).indices.map((index) => SAFETY_WORDS[index]);
}

// ---------------------------------------------------------------- proofs (§5)

/** @param {string | Uint8Array | null | undefined} challenge */
function challengeBytes(challenge) {
  const bytes = typeof challenge === 'string' ? fromB64u(challenge) : challenge;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_CHALLENGE_BYTES) {
    throw new TypeError('not a challenge');
  }
  return bytes;
}

/** @param {string | Uint8Array | null | undefined} channelId */
function channelIdBytes(channelId) {
  const bytes = typeof channelId === 'string' ? fromB64u(channelId, CHANNEL_ID_BYTES) : channelId;
  if (!Buffer.isBuffer(bytes) || bytes.length !== CHANNEL_ID_BYTES) throw new TypeError('not a channel id');
  return bytes;
}

/**
 * `lp("snotra/v1 pair-open") ‖ lp(challenge) ‖ KB_D` (§5.3)
 * @param {string | Uint8Array | null | undefined} challenge
 * @param {unknown} desktopKeys
 */
function openMessage(challenge, desktopKeys) {
  return Buffer.concat([lp(LABELS.pairOpen), lp(challengeBytes(challenge)), keyBundleBytes(desktopKeys)]);
}

/**
 * `lp("snotra/v1 pair-claim") ‖ lp(challenge) ‖ lp(channelId) ‖ KB_P` (§5.5)
 * @param {string | Uint8Array | null | undefined} challenge
 * @param {string | Uint8Array | null | undefined} channelId
 * @param {unknown} phoneKeys
 */
function claimMessage(challenge, channelId, phoneKeys) {
  return Buffer.concat([
    lp(LABELS.pairClaim), lp(challengeBytes(challenge)), lp(channelIdBytes(channelId)), keyBundleBytes(phoneKeys),
  ]);
}

/**
 * `lp("snotra/v1 token") ‖ lp(challenge) ‖ lp(channelId) ‖ lp(role)` (§5.9)
 * @param {string | Uint8Array | null | undefined} challenge
 * @param {string | Uint8Array | null | undefined} channelId
 * @param {string} role  one of `ROLES`
 */
function tokenMessage(challenge, channelId, role) {
  if (role !== ROLES.DESKTOP && role !== ROLES.PHONE) throw new TypeError('not a role');
  return Buffer.concat([lp(LABELS.token), lp(challengeBytes(challenge)), lp(channelIdBytes(channelId)), lp(role)]);
}

// ---------------------------------------------------------------- the port

/**
 * @param {{ randomBytes?: (size: number) => Uint8Array }} [deps]
 * @returns {import('../../application/ports/remote-pairing-crypto-port').RemotePairingCryptoPort}
 */
function createRemotePairingCryptoAdapter({ randomBytes = nodeCrypto.randomBytes } = {}) {
  return {
    createCode(pairingId, relayHost) {
      const code = makeCode(pairingId, drawSecret(randomBytes));
      return { code, display: displayCode(code), qr: qrPayload(relayHost, code) };
    },
    isKeyBundle,
    verifyPhoneMac,
    desktopMac: (input) => toB64u(desktopMac(input)),
    phrase,
  };
}

module.exports = {
  ALPHABET,
  CHANNEL_ID_BYTES,
  CODE_SYMBOLS,
  LABELS,
  MAC_BYTES,
  PHRASE_WORDS,
  POINT_BYTES,
  ROLES,
  SAFETY_WORDS,
  claimMessage,
  createRemotePairingCryptoAdapter,
  desktopMac,
  displayCode,
  drawSecret,
  fromB64u,
  publicKeyOf,
  isCanonicalCode,
  isKeyBundle,
  keyBundleBytes,
  lp,
  makeCode,
  openMessage,
  phoneMac,
  phrase,
  phraseIndices,
  qrPayload,
  toB64u,
  tokenMessage,
  transcript,
  verifyPhoneMac,
  verifySignature,
};
