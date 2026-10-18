// The channel test vectors of docs/remote-protocol.md, part 2 (#1113):
// handshake, session keys and envelopes, recomputed with Node's crypto from
// the pairing vectors' long-term keys. The iPhone app runs the same file
// with CryptoKit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ref = require('../scripts/remote-protocol-channel-vectors');
const pairing = require('../scripts/remote-protocol-vectors');

const vectors = ref.readVectors();
const p = pairing.readVectors();
const hex = (s) => Buffer.from(s, 'hex');
const b64u = (s) => Buffer.from(s, 'base64url');
const keysOf = (side) => ({ sign: b64u(p[side].keys.sign), agree: b64u(p[side].keys.agree) });
const sid = hex(vectors.sid);
const keyFor = (direction) => hex(direction === ref.DIRECTION.toDesktop ? vectors.keys.toDesktop : vectors.keys.toPhone);

test('the file is exactly what the generator writes — the channel has no randomness', () => {
  assert.deepEqual(ref.buildVectors(), vectors, 'run `node scripts/remote-protocol-channel-vectors.js` and commit the result');
});

test('ephemeral keys: 32-byte X25519 public keys of the raw private keys', () => {
  for (const side of ['desktop', 'phone']) {
    const pub = ref.x25519Public(hex(vectors.ephemeral[side].private));
    assert.equal(pub.length, 32);
    assert.equal(pub.toString('base64url'), vectors.ephemeral[side].public);
  }
  assert.equal(vectors.handshake1.record.e, vectors.ephemeral.phone.public);
  assert.equal(vectors.handshake2.record.e, vectors.ephemeral.desktop.public);
  assert.match(vectors.handshake1.path, /\/handshake\/phone$/);
  assert.match(vectors.handshake2.path, /\/handshake\/desktop$/);
});

test('both sides reach the same static and ephemeral agreement', () => {
  const ssDesktop = ref.staticShared(hex(p.desktop.agreePrivate), keysOf('phone').agree);
  const ssPhone = ref.staticShared(hex(p.phone.agreePrivate), keysOf('desktop').agree);
  assert.equal(ssDesktop.toString('hex'), vectors.staticShared);
  assert.equal(ssPhone.toString('hex'), vectors.staticShared);
  const eeDesktop = ref.x25519Shared(hex(vectors.ephemeral.desktop.private), b64u(vectors.ephemeral.phone.public));
  const eePhone = ref.x25519Shared(hex(vectors.ephemeral.phone.private), b64u(vectors.ephemeral.desktop.public));
  assert.equal(eeDesktop.toString('hex'), vectors.ephemeralShared);
  assert.equal(eePhone.toString('hex'), vectors.ephemeralShared);
});

test('transcript hash, session id and one key per direction', () => {
  const th = ref.transcriptHash({
    channelId: b64u(p.channelId),
    desktopKeys: keysOf('desktop'),
    phoneKeys: keysOf('phone'),
    offered: vectors.handshake1.record.v,
    phoneEphemeral: b64u(vectors.handshake1.record.e),
    chosen: vectors.handshake2.record.v,
    desktopEphemeral: b64u(vectors.handshake2.record.e),
  });
  assert.equal(th.toString('hex'), vectors.transcriptHash);
  const keys = ref.sessionKeys(hex(vectors.staticShared), hex(vectors.ephemeralShared), th);
  assert.equal(keys.sid.toString('hex'), vectors.sid);
  assert.equal(keys.toDesktop.toString('hex'), vectors.keys.toDesktop);
  assert.equal(keys.toPhone.toString('hex'), vectors.keys.toPhone);
  assert.notEqual(vectors.keys.toDesktop, vectors.keys.toPhone);
  // A different chosen version is a different transcript: no downgrade without notice.
  const other = ref.transcriptHash({
    channelId: b64u(p.channelId), desktopKeys: keysOf('desktop'), phoneKeys: keysOf('phone'),
    offered: [1, 2], phoneEphemeral: b64u(vectors.handshake1.record.e), chosen: 1, desktopEphemeral: b64u(vectors.handshake2.record.e),
  });
  assert.notEqual(other.toString('hex'), vectors.transcriptHash);
});

test('the desktop picks the highest shared version, or names its own', () => {
  assert.deepEqual(ref.chooseVersion([1]), { v: 1 });
  assert.deepEqual(ref.chooseVersion([1, 2]), { v: 1 });
  assert.deepEqual(ref.chooseVersion(vectors.versionMismatch.offered), vectors.versionMismatch.answer);
  assert.deepEqual(vectors.versionMismatch.answer, { error: 'protocol-unsupported', v: [1] });
});

test('every envelope: path, nonce, AAD and ciphertext as specified, and it opens', () => {
  const channelId = b64u(p.channelId);
  for (const e of vectors.envelopes) {
    const where = `${e.direction} #${e.counter}`;
    assert.equal(ref.envelopePath(channelId, e.direction, sid, e.counter), e.path, where);
    assert.match(e.path, /\/(to-desktop|to-phone)\/[0-9a-f]{16}\/[0-9a-f]{16}$/);
    assert.equal(ref.nonce(e.counter).toString('hex'), e.nonce, where);
    assert.equal(ref.aad(sid, e.direction, e.counter).toString('hex'), e.aad, where);
    const sealed = ref.seal(keyFor(e.direction), sid, e.direction, e.counter, e.plaintext);
    assert.equal(sealed.toString('base64url'), e.record.c, where);
    assert.equal(ref.open(keyFor(e.direction), sid, e.direction, e.counter, sealed), e.plaintext, where);
    assert.deepEqual(e.record.at, { '.sv': 'timestamp' });
  }
});

test('the phone sends requests, the desktop answers and sends events; session.hello comes first', () => {
  const messages = vectors.envelopes.map((e) => ({ ...e, json: JSON.parse(e.plaintext) }));
  for (const m of messages) assert.equal(m.json.jsonrpc, '2.0');
  for (const m of messages.filter((x) => x.direction === ref.DIRECTION.toDesktop)) {
    assert.ok(m.json.method && m.json.id !== undefined, 'a request with an id');
  }
  for (const m of messages.filter((x) => x.direction === ref.DIRECTION.toPhone)) {
    assert.ok(m.json.result !== undefined || m.json.error !== undefined || (m.json.method && m.json.id === undefined), 'an answer or an event');
  }
  const first = messages.find((m) => m.direction === ref.DIRECTION.toDesktop && m.counter === 0);
  assert.equal(first.json.method, 'session.hello');
  const answer = messages.find((m) => m.direction === ref.DIRECTION.toPhone && m.counter === 0);
  assert.equal(answer.json.result.kind, 'relay');
  assert.deepEqual(answer.json.result.approvalResponses, ['allow-once', 'deny']);
});

test('an envelope does not open under the wrong key, counter or session, nor when altered', () => {
  const e = vectors.envelopes[0];
  const sealed = b64u(e.record.c);
  assert.equal(ref.open(keyFor(ref.DIRECTION.toPhone), sid, e.direction, e.counter, sealed), null, 'the other direction\'s key');
  assert.equal(ref.open(keyFor(e.direction), sid, ref.DIRECTION.toPhone, e.counter, sealed), null, 'the other direction in the AAD');
  assert.equal(ref.open(keyFor(e.direction), sid, e.direction, e.counter + 1, sealed), null, 'another counter');
  assert.equal(ref.open(keyFor(e.direction), Buffer.alloc(8), e.direction, e.counter, sealed), null, 'another session');
  assert.equal(vectors.tampered.expect, 'reject');
  assert.equal(ref.open(keyFor(e.direction), sid, e.direction, e.counter, b64u(vectors.tampered.record.c)), null, 'one flipped bit');
});

test('the receiver delivers in order, holds a short gap, drops replays and starts over when far ahead', () => {
  assert.deepEqual(ref.receiveOrder(vectors.order.arrivals), vectors.order.actions);
  assert.equal(vectors.order.holdWindow, ref.HOLD_WINDOW);
  assert.deepEqual(ref.receiveOrder([1, 1, 0]).map((a) => a.action), ['hold', 'drop', 'deliver']);
  assert.deepEqual(ref.receiveOrder([0, ref.HOLD_WINDOW + 1]).map((a) => a.action), ['deliver', 'hold']);
  assert.deepEqual(ref.receiveOrder([0, ref.HOLD_WINDOW + 2]).map((a) => a.action), ['deliver', 'rehandshake']);
});

test('one envelope carries at most 256 KiB of plaintext', () => {
  const key = keyFor(ref.DIRECTION.toPhone);
  assert.doesNotThrow(() => ref.seal(key, sid, ref.DIRECTION.toPhone, 9, 'x'.repeat(ref.MAX_PLAINTEXT_BYTES)));
  assert.throws(() => ref.seal(key, sid, ref.DIRECTION.toPhone, 9, 'x'.repeat(ref.MAX_PLAINTEXT_BYTES + 1)), RangeError);
});

test('the spec names every channel label and points to the vector file', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'docs', 'remote-protocol.md'), 'utf8');
  for (const label of Object.values(ref.LABEL)) assert.ok(spec.includes(`"${label}"`), `docs/remote-protocol.md names "${label}"`);
  assert.ok(spec.includes('remote-protocol/channel-v1.json'), 'the spec points to the channel vectors');
});
