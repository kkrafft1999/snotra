'use strict';

// The remote bridge's pairing crypto (#1114) against the test vectors of
// docs/remote-protocol.md part 1. src/main/remote/pairing-protocol.js is
// written on its own; these vectors — which the reference script and the
// iPhone app are held to as well — are the only place the implementations
// meet.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

const protocol = require('../src/main/remote/pairing-protocol');
const { createRemotePairingCryptoAdapter } = protocol;
const vectors = require('../docs/remote-protocol/pairing-v1.json');

const fromB64u = (text) => Buffer.from(text, 'base64url');
const desktopKeys = vectors.desktop.keys;
const phoneKeys = vectors.phone.keys;
const claim = {
  code: vectors.code.code,
  channelId: vectors.channelId,
  desktopKeys,
  phoneKeys,
};

/** The signer the identity store hands out, over a known scalar. */
function signerFor(side) {
  const scalar = Buffer.from(vectors[side].signPrivate, 'hex');
  const point = fromB64u(vectors[side].keys.sign);
  const key = nodeCrypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: scalar.toString('base64url'),
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33).toString('base64url'),
    },
  });
  return (message) => nodeCrypto.sign('sha256', message, { key, dsaEncoding: 'ieee-p1363' });
}

test('the labels are the protocol\'s', () => {
  for (const [name, label] of Object.entries(vectors.labels)) assert.equal(protocol.LABELS[name], label, name);
});

test('key bundles: KB = lp(sign) ‖ lp(agree), from the public points', () => {
  assert.equal(protocol.keyBundleBytes(desktopKeys).toString('hex'), vectors.desktop.keyBundle);
  assert.equal(protocol.keyBundleBytes(phoneKeys).toString('hex'), vectors.phone.keyBundle);
  assert.equal(protocol.isKeyBundle(desktopKeys), true);
  assert.equal(protocol.isKeyBundle(phoneKeys), true);
});

test('key bundles: anything but two uncompressed points on P-256 is refused', () => {
  const point = fromB64u(desktopKeys.sign);
  const offCurve = Buffer.from(point);
  offCurve[64] ^= 1;
  const compressed = Buffer.concat([Buffer.from([0x02 | (point[64] & 1)]), point.subarray(1, 33)]);
  for (const keys of [
    null,
    {},
    { sign: desktopKeys.sign },
    { sign: offCurve.toString('base64url'), agree: desktopKeys.agree },
    { sign: compressed.toString('base64url'), agree: desktopKeys.agree },
    { sign: `${desktopKeys.sign}=`, agree: desktopKeys.agree },
    { sign: desktopKeys.sign.replace(/-/g, '+'), agree: desktopKeys.agree },
    { sign: 42, agree: desktopKeys.agree },
  ]) {
    assert.equal(protocol.isKeyBundle(keys), false, JSON.stringify(keys));
  }
});

test('the pairing code: pairing id, secret and check symbol, typed key and QR payload', () => {
  const code = protocol.makeCode(vectors.code.pairingId, BigInt(vectors.code.secretValue));
  assert.equal(code, vectors.code.code);
  assert.equal(protocol.displayCode(code), vectors.code.display);
  assert.equal(protocol.qrPayload('relay.example', code), vectors.code.qr);
  assert.equal(Buffer.from(code, 'ascii').toString('hex'), vectors.code.macKey);
  assert.equal(protocol.isCanonicalCode(code), true);
  for (const { input, expect } of vectors.parse) {
    // The bridge never parses a typed key — that is the phone's job — but it
    // must refuse every code that is not canonical before it MACs with it.
    if (expect.code) assert.equal(protocol.isCanonicalCode(expect.code), true, input);
    else assert.equal(protocol.isCanonicalCode(input), false, input);
  }
});

test('the pairing code refuses a pairing id or a secret of the wrong size', () => {
  for (const id of ['011', '01111', '011I', '011U', '', 1057]) {
    assert.throws(() => protocol.makeCode(id, 1n), TypeError, String(id));
  }
  assert.throws(() => protocol.makeCode('0111', 1n << 75n), TypeError);
  assert.throws(() => protocol.makeCode('0111', -1n), TypeError);
  assert.equal(protocol.makeCode('0111', (1n << 75n) - 1n).slice(4, 19), 'ZZZZZZZZZZZZZZZ');
});

test('a secret is 75 bits from the CSPRNG', () => {
  assert.equal(protocol.drawSecret(() => Buffer.alloc(10, 0xff)), (1n << 75n) - 1n);
  assert.equal(protocol.drawSecret(() => Buffer.alloc(10, 0)), 0n);
  let asked = 0;
  protocol.drawSecret((size) => {
    asked = size;
    return Buffer.alloc(size);
  });
  assert.equal(asked, 10);
});

test('MAC_P and MAC_D over T = lp(channelId) ‖ KB_D ‖ KB_P', () => {
  assert.equal(protocol.transcript(vectors.channelId, desktopKeys, phoneKeys).toString('hex'), vectors.transcript);
  assert.equal(protocol.toB64u(protocol.phoneMac(claim)), vectors.macP);
  assert.equal(protocol.toB64u(protocol.desktopMac(claim)), vectors.macD);
});

test('MAC_P is checked, and MAC_D cannot pass for it', () => {
  assert.equal(protocol.verifyPhoneMac({ ...claim, macP: vectors.macP }), true);
  assert.equal(protocol.verifyPhoneMac({ ...claim, macP: vectors.macD }), false, 'the labels keep one MAC from passing for the other');
  const flipped = fromB64u(vectors.macP);
  flipped[0] ^= 1;
  assert.equal(protocol.verifyPhoneMac({ ...claim, macP: flipped.toString('base64url') }), false);
  assert.equal(protocol.verifyPhoneMac({ ...claim, macP: vectors.macP.slice(0, -2) }), false);
  assert.equal(protocol.verifyPhoneMac({ ...claim, macP: undefined }), false);
  // Another secret behind the same pairing id: the person typed a wrong key.
  const otherCode = protocol.makeCode(vectors.code.pairingId, 12345n);
  assert.equal(protocol.verifyPhoneMac({ ...claim, code: otherCode, macP: vectors.macP }), false);
  // The relay swapped the phone's keys for its own.
  assert.equal(protocol.verifyPhoneMac({ ...claim, phoneKeys: desktopKeys, macP: vectors.macP }), false);
  assert.equal(protocol.verifyPhoneMac({ ...claim, phoneKeys: { sign: 'x', agree: 'y' }, macP: vectors.macP }), false);
});

test('the safety phrase: six words from H0, H1, … of the fixed list', () => {
  const { hash0, values, indices } = protocol.phraseIndices(desktopKeys, phoneKeys);
  assert.equal(hash0.toString('hex'), vectors.phrase.hash0);
  assert.deepEqual(values, vectors.phrase.values);
  assert.deepEqual(indices, vectors.phrase.indices);
  assert.deepEqual(protocol.phrase(desktopKeys, phoneKeys), vectors.phrase.words);
  assert.equal(protocol.SAFETY_WORDS.length, vectors.phrase.listSize);
  const listSha256 = nodeCrypto.createHash('sha256').update(`${protocol.SAFETY_WORDS.join('\n')}\n`).digest('hex');
  assert.equal(listSha256, vectors.phrase.listSha256);
});

test('the safety phrase skips values above the largest multiple of the list size', () => {
  // A list of 40000 words: the bound is 40000, so about two values in five are skipped.
  const { values, indices } = protocol.phraseIndices(desktopKeys, phoneKeys, 40000);
  const used = values.filter((value) => value < 40000);
  assert.deepEqual(indices, used.slice(0, 6).map((value) => value % 40000));
  assert.ok(values.length > indices.length);
});

test('every proof\'s message is the protocol\'s, and the bridge\'s signature verifies', () => {
  const messages = {
    'pair-open': protocol.openMessage(vectors.challenge, desktopKeys),
    'pair-claim': protocol.claimMessage(vectors.challenge, vectors.channelId, phoneKeys),
    'token-desktop': protocol.tokenMessage(vectors.challenge, vectors.channelId, 'desktop'),
    'token-phone': protocol.tokenMessage(vectors.challenge, vectors.channelId, 'phone'),
  };
  for (const proof of vectors.proofs) {
    const message = messages[proof.name];
    assert.equal(message.toString('hex'), proof.message, proof.name);
    const point = vectors[proof.signer].keys.sign;
    assert.equal(protocol.verifySignature(point, message, fromB64u(proof.signature)), true, `${proof.name}: the vector's signature`);
    const own = signerFor(proof.signer)(message);
    assert.equal(protocol.verifySignature(point, message, own), true, `${proof.name}: a signature made here`);
    assert.equal(protocol.verifySignature(point, Buffer.concat([message, Buffer.from([0])]), own), false);
  }
  assert.throws(() => protocol.tokenMessage(vectors.challenge, vectors.channelId, 'relay'), TypeError);
  assert.throws(() => protocol.openMessage(Buffer.alloc(65), desktopKeys), TypeError);
  assert.throws(() => protocol.claimMessage(vectors.challenge, 'short', phoneKeys), TypeError);
});

test('the crypto port: a fresh code per pairing, and the computations above', () => {
  const port = createRemotePairingCryptoAdapter();
  const first = port.createCode('0111', 'relay.example');
  const second = port.createCode('0111', 'relay.example');
  assert.match(first.code, /^0111[0-9A-HJKMNP-TV-Z]{16}$/);
  assert.notEqual(first.code, second.code, 'a new secret every time');
  assert.equal(first.display, protocol.displayCode(first.code));
  assert.equal(first.qr, `snotra-pair:v1/relay.example/${first.code}`);
  assert.equal(protocol.isCanonicalCode(first.code), true);
  assert.throws(() => port.createCode('011O', 'relay.example'), TypeError);

  const fixed = createRemotePairingCryptoAdapter({
    randomBytes: () => Buffer.from((BigInt(vectors.code.secretValue) << 5n).toString(16).padStart(20, '0'), 'hex'),
  });
  assert.equal(fixed.createCode(vectors.code.pairingId, 'relay.example').qr, vectors.code.qr);
  assert.equal(port.verifyPhoneMac({ ...claim, macP: vectors.macP }), true);
  assert.equal(port.desktopMac(claim), vectors.macD);
  assert.deepEqual(port.phrase(desktopKeys, phoneKeys), vectors.phrase.words);
  assert.equal(port.isKeyBundle(phoneKeys), true);
});

test('an error of the protocol module never quotes its input', () => {
  const secretish = vectors.macP;
  const attempts = [
    () => protocol.keyBundleBytes({ sign: secretish, agree: secretish }),
    () => protocol.transcript(secretish, desktopKeys, phoneKeys),
    () => protocol.desktopMac({ ...claim, code: secretish }),
    () => protocol.openMessage(secretish.repeat(4), desktopKeys),
  ];
  for (const attempt of attempts) {
    assert.throws(attempt, (error) => {
      assert.ok(!String(error.message).includes(secretish));
      return true;
    });
  }
});
