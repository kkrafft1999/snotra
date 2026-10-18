// The pairing test vectors of docs/remote-protocol.md (#1112): the file the
// iPhone app runs with CryptoKit is recomputed here with Node's crypto, so
// that the spec, the reference implementation and the vectors cannot drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ref = require('../scripts/remote-protocol-vectors');

const vectors = ref.readVectors();
const fromB64u = (s) => Buffer.from(s, 'base64url');
const keysOf = (side) => ({ sign: fromB64u(vectors[side].keys.sign), agree: fromB64u(vectors[side].keys.agree) });

test('the file is what the generator writes, apart from the randomised signatures', () => {
  const rebuilt = ref.buildVectors(vectors);
  assert.deepEqual(rebuilt, vectors, 'run `node scripts/remote-protocol-vectors.js` and commit the result');
});

test('public keys are the uncompressed SEC1 points of the private scalars', () => {
  for (const side of ['desktop', 'phone']) {
    for (const role of ['sign', 'agree']) {
      const point = ref.publicPoint(Buffer.from(vectors[side][`${role}Private`], 'hex'));
      assert.equal(point.length, 65);
      assert.equal(point[0], 0x04);
      assert.equal(point.toString('base64url'), vectors[side].keys[role]);
    }
    assert.equal(ref.keyBundle(keysOf(side)).toString('hex'), vectors[side].keyBundle);
  }
});

test('the pairing code: twenty symbols, groups of four, and the QR payload', () => {
  const { code } = vectors;
  assert.equal(ref.makeCode(code.pairingIdValue, BigInt(code.secretValue)), code.code);
  assert.equal(code.code.length, ref.CODE_SYMBOLS);
  assert.match(code.code, new RegExp(`^[${ref.ALPHABET}]{20}$`));
  assert.equal(code.pairingId + code.secret + code.check, code.code);
  assert.equal(ref.displayCode(code.code), code.display);
  assert.equal(code.display.split('-').length, 5);
  assert.equal(ref.qrPayload('relay.example', code.code), code.qr);
  assert.equal(Buffer.from(code.code, 'ascii').toString('hex'), code.macKey);
});

test('a typed key is read leniently, and a typo is caught before the relay is asked', () => {
  const errors = new Set();
  for (const { input, expect } of vectors.parse) {
    const parsed = ref.parseCode(input);
    if (expect.error) {
      assert.deepEqual(parsed, { error: expect.error }, JSON.stringify(input));
      errors.add(expect.error);
    } else {
      assert.equal(parsed.code, expect.code, JSON.stringify(input));
      assert.equal(parsed.pairingId, vectors.code.pairingId);
      assert.equal(parsed.secret, vectors.code.secret);
    }
  }
  assert.deepEqual([...errors].sort(), ['invalid-check', 'invalid-length', 'invalid-symbol']);
  assert.ok(vectors.parse.some((c) => /[Ol]/.test(c.input) && !c.expect.error), 'a case with look-alike letters');
});

test('MAC_P and MAC_D cover the channel and both key bundles, and differ by their label', () => {
  const channelId = fromB64u(vectors.channelId);
  assert.equal(channelId.length, 16);
  const desktop = keysOf('desktop');
  const phone = keysOf('phone');
  assert.equal(ref.transcript(channelId, desktop, phone).toString('hex'), vectors.transcript);
  assert.equal(ref.macPhone(vectors.code.code, channelId, desktop, phone).toString('base64url'), vectors.macP);
  assert.equal(ref.macDesktop(vectors.code.code, channelId, desktop, phone).toString('base64url'), vectors.macD);
  assert.notEqual(vectors.macP, vectors.macD);
  // A key swapped in by the relay changes the MAC.
  const swapped = { ...phone, agree: desktop.agree };
  assert.notEqual(ref.macPhone(vectors.code.code, channelId, desktop, swapped).toString('base64url'), vectors.macP);
});

test('the safety phrase: six indices into the word list, the same from both sides', () => {
  const { phrase } = vectors;
  const result = ref.phraseIndices(keysOf('desktop'), keysOf('phone'), phrase.listSize);
  assert.equal(result.hash0.toString('hex'), phrase.hash0);
  assert.deepEqual(result.values, phrase.values);
  assert.deepEqual(result.indices, phrase.indices);
  assert.equal(phrase.indices.length, ref.PHRASE_WORDS);
  for (const index of phrase.indices) assert.ok(index >= 0 && index < phrase.listSize);
  // Swapping the sides is a different phrase: the order of the bundles is part of the input.
  assert.notDeepEqual(ref.phraseIndices(keysOf('phone'), keysOf('desktop'), phrase.listSize).indices, phrase.indices);
});

test('a value at or above the largest multiple of the list size is skipped, not folded', () => {
  // 1296 words: values 64800..65535 would make the first 736 words likelier.
  const bound = Math.floor(65536 / 1296) * 1296;
  assert.equal(bound, 64800);
  const { values, indices } = ref.phraseIndices(keysOf('desktop'), keysOf('phone'), 1296, 64);
  const used = values.filter((v) => v < bound).map((v) => v % 1296);
  assert.deepEqual(used.slice(0, indices.length), indices);
});

test('every proof verifies against its signer\'s key, over exactly the bytes the spec names', () => {
  const challenge = fromB64u(vectors.challenge);
  const channelId = fromB64u(vectors.channelId);
  const expected = {
    'pair-open': ref.openMessage(challenge, keysOf('desktop')),
    'pair-claim': ref.claimMessage(challenge, channelId, keysOf('phone')),
    'token-desktop': ref.tokenMessage(challenge, channelId, 'desktop'),
    'token-phone': ref.tokenMessage(challenge, channelId, 'phone'),
  };
  assert.deepEqual(vectors.proofs.map((p) => p.name).sort(), Object.keys(expected).sort());
  for (const proof of vectors.proofs) {
    const message = expected[proof.name];
    assert.equal(message.toString('hex'), proof.message, proof.name);
    const signature = fromB64u(proof.signature);
    assert.equal(signature.length, 64, `${proof.name}: r ‖ s, 64 bytes`);
    assert.ok(ref.verify(keysOf(proof.signer).sign, message, signature), `${proof.name} verifies`);
    const other = proof.signer === 'desktop' ? 'phone' : 'desktop';
    assert.equal(ref.verify(keysOf(other).sign, message, signature), false, `${proof.name} does not verify for the ${other}`);
  }
});

test('the spec names every label the vectors use', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'docs', 'remote-protocol.md'), 'utf8');
  for (const label of Object.values(ref.LABEL)) assert.ok(spec.includes(`"${label}"`), `docs/remote-protocol.md names "${label}"`);
  assert.ok(spec.includes('remote-protocol/pairing-v1.json'), 'the spec points to the vector file');
});
