'use strict';

// The desktop's channel (#1192) against the reference phone (#1135), end to
// end over HTTP: src/application/remote/remote-channel.js with the bridge's
// Firebase adapter and channel crypto on one side, e2e/remote/reference-phone.js
// with the reference implementation of the protocol on the other, the relay
// stand-in between them. What the relay itself must do is the conformance
// runner's job (test/remote-relay-conformance.test.js); this holds the
// desktop's decisions to a phone written apart from it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRelayStandIn } = require('../e2e/remote/relay-stand-in');
const { createReferencePhone, createKeys } = require('../e2e/remote/reference-phone');
const { createFirebaseRelayAdapter } = require('../src/main/remote/firebase-relay-adapter');
const { createRemoteChannelCryptoAdapter } = require('../src/main/remote/channel-protocol');
const protocol = require('../src/main/remote/pairing-protocol');
const { createRemoteChannel } = require('../src/application/remote/remote-channel');
const { createRemoteMessageStandIn } = require('../src/application/remote/remote-message-stand-in');
const { REMOTE_RPC_ERRORS } = require('../src/shared/contracts/remote/rpc-errors');
const { translateMessage } = require('../src/shared/i18n');

const HELLO = Object.freeze({ protocol: [1], client: { name: 'snotra-reference-phone', version: '1' } });

/**
 * Waits for `condition` to hold, polling.
 * @param {() => unknown} condition
 * @param {string} what
 */
async function eventually(condition, what, ms = 5000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${what} did not happen within ${ms} ms`);
}

/**
 * A relay stand-in, a desktop paired with a reference phone through it, and
 * the desktop's channel for that phone — not started yet.
 *
 * @param {import('node:test').TestContext} t
 */
async function paired(t) {
  const relay = createRelayStandIn();
  const config = await relay.start();
  t.after(() => relay.stop());

  const adapter = createFirebaseRelayAdapter({ endpoint: config });
  t.after(() => adapter.close());
  const desktopKeys = createKeys();
  const opened = await adapter.openPairing({ desktopKeys: desktopKeys.bundle, sign: desktopKeys.sign });
  const code = protocol.makeCode(opened.pairingId, protocol.drawSecret());

  const phone = createReferencePhone(config);
  t.after(() => phone.closeStreams());
  await phone.lookup(protocol.displayCode(code));
  await phone.claim();
  const macD = protocol.toB64u(protocol.desktopMac({
    code, channelId: opened.channelId, desktopKeys: desktopKeys.bundle, phoneKeys: phone.keys,
  }));
  await adapter.confirmPairing(opened.channelId, macD);

  /** @type {string[]} */
  const gone = [];
  /** @type {string[]} */
  const warnings = [];
  const channel = createRemoteChannel({
    relay: adapter,
    identity: {
      isAvailable: () => true,
      loadIdentity: async () => ({ keys: desktopKeys.bundle, sign: desktopKeys.sign, agree: desktopKeys.agree }),
      readPhone: async () => ({ channelId: opened.channelId, keys: phone.keys, pairedAt: Date.now() }),
      savePhone: async () => {},
      forgetPhone: async () => {},
    },
    crypto: createRemoteChannelCryptoAdapter(),
    messages: createRemoteMessageStandIn({ word: translateMessage }),
    word: translateMessage,
    appVersion: () => '0.0.0-test',
    newConnectionId: () => `connection-${gone.length}`,
    onGone: (channelId) => gone.push(channelId),
    log: { warn: (line) => warnings.push(String(line)) },
  });
  t.after(() => channel.dispose());
  return { relay, channel, phone, channelId: opened.channelId, gone, warnings };
}

/**
 * The desktop's streams stand, the phone follows its nodes.
 * @param {Awaited<ReturnType<typeof paired>>} setup
 */
async function connect({ channel, phone }) {
  await channel.start();
  await eventually(() => channel.inspect().live, 'the desktop\'s four streams');
  await phone.connect();
}

test('the reference phone shakes hands, says hello and is answered by the desktop\'s channel', async (t) => {
  const setup = await paired(t);
  const { channel, phone } = setup;
  /** @type {boolean[]} */
  const states = [];
  channel.subscribe(({ connected }) => states.push(connected));
  await connect(setup);

  // The desktop's heartbeat starts with its streams (§12).
  const presence = await phone.stream('presence/desktop').until((r) => typeof r?.lastSeen === 'number', 'lastSeen');
  assert.ok(Math.abs(presence.lastSeen - Date.now()) < 60_000);

  // A version the desktop does not speak: it says which it does (§13).
  await phone.offer({ offered: [2] });
  assert.deepEqual(await phone.answer(), { error: 'protocol-unsupported', v: [1] });

  await phone.offer();
  const { v, sid } = await phone.answer();
  assert.equal(v, 1);
  assert.match(sid, /^[0-9a-f]{16}$/);
  assert.equal(channel.isConnected(), false, 'a handshake alone is no connection (§14)');

  const hello = await phone.request('session.hello', HELLO);
  assert.equal(hello.result.protocol, 1);
  assert.equal(hello.result.kind, 'relay');
  assert.equal(hello.result.connectionId, 'connection-0');
  assert.equal(hello.result.app.version, '0.0.0-test');
  assert.deepEqual(hello.result.methods, ['session.hello', 'session.bye']);
  assert.equal(channel.isConnected(), true);
  assert.deepEqual(states, [true]);

  // Until the dispatcher exists (#1194), every other method is unavailable.
  const other = await phone.request('chat.list');
  assert.equal(other.error.code, REMOTE_RPC_ERRORS.unavailable);
  assert.equal(other.error.data.reason, 'unavailable');
  assert.equal(typeof other.error.message, 'string');
  assert.ok(other.error.message.length > 0);

  // The desktop deleted what it read, the phone what it read (§15).
  assert.equal(setup.relay.inspect().channels, 1);
  assert.deepEqual(channel.inspect().session, { next: 2, out: 2, held: 0 });
  assert.equal((await phone.read(`to-phone/${sid}`)).value, null);
});

test('an envelope that does not open ends the session, and a new handshake starts the next one', async (t) => {
  const setup = await paired(t);
  const { channel, phone } = setup;
  await connect(setup);
  await phone.offer();
  const first = await phone.answer();
  await phone.request('session.hello', HELLO);
  assert.equal(channel.isConnected(), true);

  await phone.send({ jsonrpc: '2.0', id: 'x', method: 'session.bye', params: {} }, { tamper: true });
  await eventually(() => !channel.isConnected(), 'the desktop ending the session on a bad tag (§16)');
  assert.ok(setup.warnings.some((line) => line.includes('starts over (tag)')));

  await phone.offer();
  const second = await phone.answer();
  assert.notEqual(second.sid, first.sid);
  const hello = await phone.request('session.hello', HELLO);
  assert.equal(hello.result.connectionId, 'connection-0');
  assert.equal(channel.isConnected(), true);
  assert.deepEqual(channel.inspect().session, { next: 1, out: 1, held: 0 });
});

test('a request before session.hello is answered connection-unknown (§17)', async (t) => {
  const setup = await paired(t);
  const { channel, phone } = setup;
  await connect(setup);
  await phone.offer();
  await phone.answer();
  const early = await phone.request('chat.list');
  assert.equal(early.error.code, REMOTE_RPC_ERRORS['connection-unknown']);
  assert.equal(channel.isConnected(), false);
});

test('the desktop deletes its presence when it quits (§12)', async (t) => {
  const setup = await paired(t);
  const { channel, phone } = setup;
  await connect(setup);
  await phone.stream('presence/desktop').until((r) => r !== null, 'presence');
  channel.dispose();
  await phone.stream('presence/desktop').until((r) => r === null, 'no presence');
});

test('the phone deletes the channel: the desktop learns the phone is gone (§12)', async (t) => {
  const setup = await paired(t);
  const { channel, phone, channelId, gone } = setup;
  await connect(setup);
  await phone.offer();
  await phone.answer();
  await phone.request('session.hello', HELLO);
  phone.closeStreams();
  await phone.disconnect();
  await eventually(() => gone.length > 0, `onGone; warnings: ${JSON.stringify(setup.warnings)}`);
  assert.deepEqual(gone, [channelId]);
  assert.equal(channel.isConnected(), false);
  assert.equal(channel.inspect().linked, false);
});
