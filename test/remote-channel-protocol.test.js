'use strict';

// The bridge's own computations for part 2 of the remote protocol (#1192),
// src/main/remote/channel-protocol.js, against docs/remote-protocol/channel-v1.json:
// handshake 2, `th`, `sid`, both keys (through the envelopes they seal), the
// four envelopes byte for byte, the flipped bit. The long-term agreement goes
// through the identity store's `agree`, as in the app.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const channel = require('../src/main/remote/channel-protocol');
const { createRemoteIdentityStore } = require('../src/main/remote/identity-store-adapter');
const { writeFileAtomic } = require('../src/main/services/atomic-write');
const vectors = require('../docs/remote-protocol/channel-v1.json');
const pairingVectors = require('../docs/remote-protocol/pairing-v1.json');
const { createFakeSafeStorage, createLog, tempDir } = require('./helpers/remote-pairing');

/** The desktop's agreement as the vectors fix it: P-256 ECDH with the pairing vectors' scalar. */
function vectorAgree(point) {
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(pairingVectors.desktop.agreePrivate, 'hex'));
  return ecdh.computeSecret(Buffer.from(point, 'base64url'));
}

function answer() {
  const adapter = channel.createRemoteChannelCryptoAdapter({ randomBytes: () => Buffer.from(vectors.ephemeral.desktop.private, 'hex') });
  return adapter.answerHandshake({
    channelId: pairingVectors.channelId,
    desktopKeys: pairingVectors.desktop.keys,
    phoneKeys: pairingVectors.phone.keys,
    offered: vectors.handshake1.record.v,
    chosen: vectors.handshake2.record.v,
    phoneEphemeral: vectors.handshake1.record.e,
    agree: vectorAgree,
  });
}

test('handshake 2 and the session id are those of the vectors', () => {
  const { desktopEphemeral, session } = answer();
  assert.equal(desktopEphemeral, vectors.handshake2.record.e);
  assert.equal(session.sid, vectors.sid);
  assert.equal(vectorAgree(pairingVectors.phone.keys.agree).toString('hex'), vectors.staticShared, '`ss`');
});

test('the transcript hash is that of the vectors', () => {
  const th = channel.transcriptHash({
    channelId: Buffer.from(pairingVectors.channelId, 'base64url'),
    desktopKeys: pairingVectors.desktop.keys,
    phoneKeys: pairingVectors.phone.keys,
    offered: vectors.handshake1.record.v,
    phoneEphemeral: Buffer.from(vectors.handshake1.record.e, 'base64url'),
    chosen: vectors.handshake2.record.v,
    desktopEphemeral: Buffer.from(vectors.handshake2.record.e, 'base64url'),
  });
  assert.equal(th.toString('hex'), vectors.transcriptHash);
});

test('the four envelopes: sealed to the phone and opened from it, byte for byte', () => {
  const { session } = answer();
  for (const envelope of vectors.envelopes) {
    assert.equal(channel.nonce(envelope.counter).toString('hex'), envelope.nonce);
    assert.equal(channel.associatedData(Buffer.from(vectors.sid, 'hex'), envelope.direction, envelope.counter).toString('hex'), envelope.aad);
    assert.ok(envelope.path.endsWith(`/${envelope.direction}/${vectors.sid}/${channel.counterKey(envelope.counter)}`));
    if (envelope.direction === channel.DIRECTIONS.TO_PHONE) {
      assert.equal(session.seal(envelope.counter, envelope.plaintext), envelope.record.c, `to-phone ${envelope.counter}`);
    } else {
      assert.equal(session.open(envelope.counter, envelope.record.c), envelope.plaintext, `to-desktop ${envelope.counter}`);
    }
  }
});

test('a flipped bit, the wrong counter or a malformed record does not open', () => {
  const { session } = answer();
  const first = vectors.envelopes[0];
  assert.equal(session.open(first.counter, vectors.tampered.record.c), null);
  assert.equal(session.open(first.counter + 1, first.record.c), null, 'bound to its counter');
  assert.equal(session.open(first.counter, 'not base64url!'), null);
  assert.equal(session.open(first.counter, ''), null);
});

test('a session forgets its keys', () => {
  const { session } = answer();
  session.forget();
  assert.throws(() => session.seal(0, '{}'), /ended/);
  assert.throws(() => session.open(0, vectors.envelopes[0].record.c), /ended/);
});

test('a message over 256 KiB is not sealed', () => {
  const { session } = answer();
  assert.throws(() => session.seal(0, 'x'.repeat(channel.MAX_PLAINTEXT_BYTES + 1)), RangeError);
  assert.equal(typeof session.seal(0, 'x'.repeat(channel.MAX_PLAINTEXT_BYTES)), 'string');
});

test('a key that is not one is refused', () => {
  const adapter = channel.createRemoteChannelCryptoAdapter();
  assert.equal(adapter.isEphemeralKey(vectors.handshake1.record.e), true);
  assert.equal(adapter.isEphemeralKey(`${vectors.handshake1.record.e}A`), false);
  assert.equal(adapter.isEphemeralKey(Buffer.alloc(31).toString('base64url')), false);
  // A low-order point gives no agreement: OpenSSL refuses it.
  assert.throws(() => adapter.answerHandshake({
    channelId: pairingVectors.channelId,
    desktopKeys: pairingVectors.desktop.keys,
    phoneKeys: pairingVectors.phone.keys,
    offered: [1],
    chosen: 1,
    phoneEphemeral: Buffer.alloc(32).toString('base64url'),
    agree: vectorAgree,
  }));
});

test('the identity store agrees as P-256 ECDH does, and keeps the key to itself', async (t) => {
  const store = createRemoteIdentityStore({ safeStorage: createFakeSafeStorage(), fs: fsp, path, dir: tempDir(t), writeFileAtomic, log: createLog() });
  const identity = await store.loadIdentity();
  const other = nodeCrypto.createECDH('prime256v1');
  other.generateKeys();
  const ours = Buffer.from(identity.agree(other.getPublicKey().toString('base64url')));
  assert.equal(ours.toString('hex'), other.computeSecret(Buffer.from(identity.keys.agree, 'base64url')).toString('hex'));
  assert.throws(() => identity.agree(Buffer.alloc(65, 4).toString('base64url')), /not a P-256 point/);
});
