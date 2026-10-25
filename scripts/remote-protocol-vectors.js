'use strict';
/**
 * Reference implementation of the pairing computations in
 * docs/remote/remote-protocol.md, part 1 (#1112), and the generator of its test
 * vectors, docs/remote/remote-protocol/pairing-v1.json.
 *
 * It exists to pin down bytes, not to run in the app: the remote bridge
 * (#1114) and the iPhone app implement the same functions on their own and
 * prove them against the vectors. test/remote-protocol-vectors.test.js keeps
 * this file, the vectors and the spec in step.
 *
 *   node scripts/remote-protocol-vectors.js    rewrites the vector file
 *
 * ECDSA signatures are randomised, so a rerun keeps every signature in the
 * file that still verifies and only signs what changed.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VECTOR_FILE = path.join(__dirname, '..', 'docs', 'remote', 'remote-protocol', 'pairing-v1.json');
const WORD_LIST_FILE = 'src/shared/contracts/remote/safety-words-v1.json';
const SAFETY_WORDS = require(`../${WORD_LIST_FILE}`).words;

/** Crockford's base32 alphabet: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIRING_ID_SYMBOLS = 4; // 20 bits, minted by the relay
const SECRET_SYMBOLS = 15; // 75 bits, from the desktop's CSPRNG
const CODE_SYMBOLS = PAIRING_ID_SYMBOLS + SECRET_SYMBOLS + 1; // + check symbol

/** The EFF short word list 2.0 (decided 2026-10-18, #1116). */
const WORD_LIST_SIZE = SAFETY_WORDS.length;
const PHRASE_WORDS = 6;

const LABEL = Object.freeze({
  codeCheck: 'snotra/v1 code-check',
  macPhone: 'snotra/v1 mac phone',
  macDesktop: 'snotra/v1 mac desktop',
  phrase: 'snotra/v1 phrase',
  pairOpen: 'snotra/v1 pair-open',
  pairClaim: 'snotra/v1 pair-claim',
  token: 'snotra/v1 token',
});

function bytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

/** `lp(x) = u16be(len(x)) ‖ x` — every variable-length part of a hashed or signed input. */
function lp(value) {
  const body = bytes(value);
  if (body.length > 0xffff) throw new RangeError('lp: longer than 65535 bytes');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length);
  return Buffer.concat([head, body]);
}

function sha256(...parts) {
  return crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
}

function hmac(key, ...parts) {
  return crypto.createHmac('sha256', key).update(Buffer.concat(parts)).digest();
}

// ---------------------------------------------------------------- keys

/** The public SEC1 point (65 bytes, uncompressed) of a P-256 private scalar. */
function publicPoint(privateScalar) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateScalar);
  return ecdh.getPublicKey();
}

function signingKey(privateScalar) {
  const point = publicPoint(privateScalar);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: privateScalar.toString('base64url'),
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33).toString('base64url'),
    },
  });
}

function verifyingKey(point) {
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('not an uncompressed P-256 point');
  return crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
  });
}

/** `KB = lp(sign) ‖ lp(agree)`, both SEC1 points. */
function keyBundle({ sign, agree }) {
  return Buffer.concat([lp(sign), lp(agree)]);
}

function sign(privateScalar, message) {
  return crypto.sign('sha256', message, { key: signingKey(privateScalar), dsaEncoding: 'ieee-p1363' });
}

function verify(point, message, signature) {
  return crypto.verify('sha256', message, { key: verifyingKey(point), dsaEncoding: 'ieee-p1363' }, signature);
}

// ---------------------------------------------------------------- pairing code

function encodeSymbols(value, count) {
  let n = BigInt(value);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  if (n !== 0n) throw new RangeError('value does not fit');
  return out;
}

function checkSymbol(body) {
  return ALPHABET[sha256(lp(LABEL.codeCheck), Buffer.from(body, 'ascii'))[0] >> 3];
}

/** The 20-symbol code from the relay's pairing id (20 bits) and the desktop's secret (75 bits). */
function makeCode(pairingIdValue, secretValue) {
  const body = encodeSymbols(pairingIdValue, PAIRING_ID_SYMBOLS) + encodeSymbols(secretValue, SECRET_SYMBOLS);
  return body + checkSymbol(body);
}

/** `7KQM-3XWD-…`: the typed key as the desktop shows it, groups of four. */
function displayCode(code) {
  return code.match(/.{1,4}/g).join('-');
}

function qrPayload(relayHost, code) {
  return `snotra-pair:v1/${relayHost}/${code}`;
}

/**
 * Reads a typed key: case is ignored, `-` and spaces are dropped, O reads as
 * 0 and I or L as 1. Anything else outside the alphabet, a wrong length or a
 * wrong check symbol is refused before the phone contacts the relay.
 */
function parseCode(input) {
  const cleaned = String(input).toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (/[^0-9A-Z]/.test(cleaned) || /[U]/.test(cleaned)) return { error: 'invalid-symbol' };
  if (cleaned.length !== CODE_SYMBOLS) return { error: 'invalid-length' };
  const body = cleaned.slice(0, -1);
  if (checkSymbol(body) !== cleaned.slice(-1)) return { error: 'invalid-check' };
  return {
    code: cleaned,
    pairingId: cleaned.slice(0, PAIRING_ID_SYMBOLS),
    secret: cleaned.slice(PAIRING_ID_SYMBOLS, -1),
  };
}

/** The HMAC key of `MAC_P` and `MAC_D`: the canonical code's 20 ASCII bytes. */
function macKey(code) {
  return Buffer.from(code, 'ascii');
}

// ---------------------------------------------------------------- MACs and the phrase

/** `T = lp(channelId) ‖ KB(desktop) ‖ KB(phone)`, the channel id as its 16 raw bytes. */
function transcript(channelId, desktopKeys, phoneKeys) {
  return Buffer.concat([lp(channelId), keyBundle(desktopKeys), keyBundle(phoneKeys)]);
}

function macPhone(code, channelId, desktopKeys, phoneKeys) {
  return hmac(macKey(code), lp(LABEL.macPhone), transcript(channelId, desktopKeys, phoneKeys));
}

function macDesktop(code, channelId, desktopKeys, phoneKeys) {
  return hmac(macKey(code), lp(LABEL.macDesktop), transcript(channelId, desktopKeys, phoneKeys));
}

/**
 * Six word indices from both key bundles: 16-bit big-endian values from
 * `H0 = SHA-256(lp(label) ‖ KB(desktop) ‖ KB(phone))`, then `H1 = SHA-256(H0)`
 * and on; a value is used when it is below the largest multiple of the list
 * size, as `value mod size`, so that every word is equally likely.
 */
function phraseIndices(desktopKeys, phoneKeys, listSize = WORD_LIST_SIZE, words = PHRASE_WORDS) {
  const bound = Math.floor(65536 / listSize) * listSize;
  const values = [];
  const indices = [];
  let block = sha256(lp(LABEL.phrase), keyBundle(desktopKeys), keyBundle(phoneKeys));
  const first = block;
  while (indices.length < words) {
    for (let i = 0; i + 1 < block.length && indices.length < words; i += 2) {
      const value = block.readUInt16BE(i);
      values.push(value);
      if (value < bound) indices.push(value % listSize);
    }
    block = sha256(block);
  }
  return { hash0: first, values, indices };
}

/** The words for the indices, and the checksum that pins the list to protocol version 1. */
function phraseWords(indices) {
  return indices.map((i) => SAFETY_WORDS[i]);
}

function wordListSha256() {
  return sha256(Buffer.from(`${SAFETY_WORDS.join('\n')}\n`, 'utf8')).toString('hex');
}

// ---------------------------------------------------------------- proofs for the relay

function openMessage(challenge, desktopKeys) {
  return Buffer.concat([lp(LABEL.pairOpen), lp(challenge), keyBundle(desktopKeys)]);
}

function claimMessage(challenge, channelId, phoneKeys) {
  return Buffer.concat([lp(LABEL.pairClaim), lp(challenge), lp(channelId), keyBundle(phoneKeys)]);
}

function tokenMessage(challenge, channelId, role) {
  return Buffer.concat([lp(LABEL.token), lp(challenge), lp(channelId), lp(role)]);
}

// ---------------------------------------------------------------- the vectors

/** Fixed inputs. Private scalars are hashes of a label, so anybody can rebuild them. */
function fixedInputs() {
  const scalar = (label) => sha256(Buffer.from(label, 'utf8'));
  const secretBits = BigInt(`0x${sha256(Buffer.from('snotra test pairing secret')).toString('hex')}`) >> (256n - 75n);
  return {
    relayHost: 'relay.example',
    desktop: { sign: scalar('snotra test desktop sign'), agree: scalar('snotra test desktop agree') },
    phone: { sign: scalar('snotra test phone sign'), agree: scalar('snotra test phone agree') },
    pairingIdValue: 0x00421, // "1011": a 0 and 1s, so the look-alike case reads O and l
    secretValue: secretBits,
    channelId: sha256(Buffer.from('snotra test channel')).subarray(0, 16),
    challenge: sha256(Buffer.from('snotra test challenge')),
  };
}

function publicKeys(scalars) {
  return { sign: publicPoint(scalars.sign), agree: publicPoint(scalars.agree) };
}

const b64u = (buf) => buf.toString('base64url');
const hex = (buf) => buf.toString('hex');

/** The parse cases: what a person may type, and what the phone makes of it. */
function parseCases(code) {
  const display = displayCode(code);
  const lower = display.toLowerCase();
  const withLookalikes = code.replace(/0/g, 'O').replace(/1/g, 'l');
  const wrongCheck = code.slice(0, -1) + ALPHABET[(ALPHABET.indexOf(code.slice(-1)) + 1) % 32];
  return [
    { input: display, expect: { code } },
    { input: lower, expect: { code } },
    { input: ` ${code.slice(0, 10)} ${code.slice(10)} `, expect: { code } },
    { input: withLookalikes, expect: { code } },
    { input: code.slice(0, -1), expect: { error: 'invalid-length' } },
    { input: `${code.slice(0, -1)}U`, expect: { error: 'invalid-symbol' } },
    { input: wrongCheck, expect: { error: 'invalid-check' } },
  ];
}

function buildVectors(previous = null) {
  const input = fixedInputs();
  const desktopKeys = publicKeys(input.desktop);
  const phoneKeys = publicKeys(input.phone);
  const code = makeCode(input.pairingIdValue, input.secretValue);
  const phrase = phraseIndices(desktopKeys, phoneKeys);

  const keep = (name, message) => {
    const old = previous?.proofs?.find((p) => p.name === name);
    return old && old.message === hex(message) ? old.signature : null;
  };
  const proof = (name, signer, scalar, point, message) => {
    let signature = keep(name, message);
    if (!signature || !verify(point, message, Buffer.from(signature, 'base64url'))) signature = b64u(sign(scalar, message));
    return { name, signer, message: hex(message), signature };
  };

  return {
    protocol: 1,
    part: 'pairing',
    spec: 'docs/remote/remote-protocol.md',
    generatedBy: 'node scripts/remote-protocol-vectors.js',
    note: 'Hex for byte strings that are only hashed or signed; base64url without padding where the value travels in JSON. Signatures are randomised: verify them, do not compare them.',
    labels: LABEL,
    desktop: {
      signPrivate: hex(input.desktop.sign),
      agreePrivate: hex(input.desktop.agree),
      keys: { sign: b64u(desktopKeys.sign), agree: b64u(desktopKeys.agree) },
      keyBundle: hex(keyBundle(desktopKeys)),
    },
    phone: {
      signPrivate: hex(input.phone.sign),
      agreePrivate: hex(input.phone.agree),
      keys: { sign: b64u(phoneKeys.sign), agree: b64u(phoneKeys.agree) },
      keyBundle: hex(keyBundle(phoneKeys)),
    },
    code: {
      pairingIdValue: input.pairingIdValue,
      secretValue: `0x${input.secretValue.toString(16)}`,
      pairingId: code.slice(0, PAIRING_ID_SYMBOLS),
      secret: code.slice(PAIRING_ID_SYMBOLS, -1),
      check: code.slice(-1),
      code,
      display: displayCode(code),
      qr: qrPayload(input.relayHost, code),
      macKey: hex(macKey(code)),
    },
    parse: parseCases(code),
    channelId: b64u(input.channelId),
    transcript: hex(transcript(input.channelId, desktopKeys, phoneKeys)),
    macP: b64u(macPhone(code, input.channelId, desktopKeys, phoneKeys)),
    macD: b64u(macDesktop(code, input.channelId, desktopKeys, phoneKeys)),
    phrase: {
      list: WORD_LIST_FILE,
      listSha256: wordListSha256(),
      listSize: WORD_LIST_SIZE,
      hash0: hex(phrase.hash0),
      values: phrase.values,
      indices: phrase.indices,
      words: phraseWords(phrase.indices),
      shown: phraseWords(phrase.indices).join(' · '),
    },
    challenge: b64u(input.challenge),
    proofs: [
      proof('pair-open', 'desktop', input.desktop.sign, desktopKeys.sign, openMessage(input.challenge, desktopKeys)),
      proof('pair-claim', 'phone', input.phone.sign, phoneKeys.sign, claimMessage(input.challenge, input.channelId, phoneKeys)),
      proof('token-desktop', 'desktop', input.desktop.sign, desktopKeys.sign, tokenMessage(input.challenge, input.channelId, 'desktop')),
      proof('token-phone', 'phone', input.phone.sign, phoneKeys.sign, tokenMessage(input.challenge, input.channelId, 'phone')),
    ],
  };
}

function readVectors() {
  return JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));
}

if (require.main === module) {
  let previous = null;
  try {
    previous = readVectors();
  } catch {
    // first run
  }
  fs.mkdirSync(path.dirname(VECTOR_FILE), { recursive: true });
  fs.writeFileSync(VECTOR_FILE, `${JSON.stringify(buildVectors(previous), null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), VECTOR_FILE)}`);
}

module.exports = {
  ALPHABET,
  CODE_SYMBOLS,
  LABEL,
  PHRASE_WORDS,
  SAFETY_WORDS,
  VECTOR_FILE,
  WORD_LIST_FILE,
  WORD_LIST_SIZE,
  buildVectors,
  claimMessage,
  displayCode,
  keyBundle,
  lp,
  macDesktop,
  macPhone,
  makeCode,
  openMessage,
  parseCode,
  phraseIndices,
  phraseWords,
  publicPoint,
  qrPayload,
  readVectors,
  tokenMessage,
  transcript,
  verify,
  wordListSha256,
};
