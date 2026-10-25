'use strict';

// The channel to the paired phone (#1192): the core of
// src/application/remote/remote-channel.js against the in-memory relay, with
// a phone that computes its half with the reference implementation. Every row
// of the receive rules of docs/remote/remote-protocol.md §16, the handshake of §13,
// `session.hello` of §17, presence (§12.3) and a vanishing `meta` (§12.2).

const test = require('node:test');
const assert = require('node:assert/strict');

const { HOLD_MS, PHONE_PRESENCE_TIMEOUT_MS, PRESENCE_INTERVAL_MS, SESSION_MAX_MS } = require('../src/application/remote/remote-channel');
const { REMOTE_RPC_ERRORS } = require('../src/shared/contracts/remote/rpc-errors');
const { HELLO, createChannelFixture, createChannelPhone, pairedFixture, tick } = require('./helpers/remote-channel');

/** A paired phone, the channel started, the streams standing. */
async function connected(t, options) {
  const paired = await pairedFixture(t);
  const { fixture, phone, channelId, desktopKeys } = paired;
  const harness = createChannelFixture(t, paired, options);
  await harness.channel.start();
  await fixture.until(() => harness.channel.inspect().live, 'the channel to stand');
  const mobile = createChannelPhone(fixture.relay, phone, channelId, desktopKeys);
  return { ...paired, ...harness, mobile, until: fixture.until, relay: fixture.relay, clock: fixture.clock };
}

/** Handshake, `session.hello`, and its answer read. */
async function session(t, options) {
  const ctx = await connected(t, options);
  await ctx.mobile.handshake({ until: ctx.until });
  await ctx.mobile.send(HELLO);
  const [answer] = await ctx.until(() => {
    const got = ctx.mobile.receive();
    return got.length ? got : null;
  }, 'the answer to session.hello');
  return { ...ctx, hello: answer };
}

/** What reached `to-phone`, once something has. */
async function nextAnswers(ctx, count = 1) {
  const got = [];
  await ctx.until(() => {
    got.push(...ctx.mobile.receive());
    return got.length >= count;
  }, `${count} answer(s)`);
  return got;
}

const inbox = (ctx) => ctx.relay.inspect.nodes(ctx.channelId).toDesktop;

test('a paired phone is connected to on start, and presence is written — the phone is not connected by it', async (t) => {
  const ctx = await connected(t);
  const nodes = ctx.relay.inspect.nodes(ctx.channelId);
  assert.ok(nodes.presence.desktop?.lastSeen, 'presence/desktop is written as soon as the streams stand');
  assert.equal(ctx.relay.inspect.links(), 1);

  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await ctx.until(() => ctx.channel.inspect().phoneOnline, 'the phone\'s presence read');
  assert.equal(ctx.channel.isConnected(), false, 'presence alone is no connection (§12.3)');
});

test('nothing connects without a paired phone', async (t) => {
  const { createPairingFixture } = require('./helpers/remote-pairing');
  const fixture = createPairingFixture(t);
  const harness = createChannelFixture(t, { fixture });
  await harness.channel.start();
  assert.equal(harness.channel.inspect().linked, false);
  assert.ok(!fixture.relay.inspect.calls().includes('openChannel'), 'R7: no request without a phone');
});

test('presence is renewed every 30 seconds and deleted when the channel stops', async (t) => {
  const ctx = await connected(t);
  const first = ctx.relay.inspect.nodes(ctx.channelId).presence.desktop.lastSeen;
  ctx.clock.advance(PRESENCE_INTERVAL_MS);
  await ctx.until(() => ctx.relay.inspect.nodes(ctx.channelId).presence.desktop?.lastSeen > first, 'a new heartbeat');
  ctx.channel.dispose();
  await ctx.until(() => ctx.relay.inspect.nodes(ctx.channelId).presence.desktop === null, 'presence deleted on quit');
  assert.equal(ctx.relay.inspect.links(), 0);
});

test('the phone is gone once its heartbeat is more than 90 seconds old, without another event (§12.3, #1227)', async (t) => {
  const ctx = await connected(t);
  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await ctx.until(() => ctx.channel.inspect().phoneOnline, 'the heartbeat read');
  ctx.clock.advance(PHONE_PRESENCE_TIMEOUT_MS);
  assert.equal(ctx.channel.inspect().phoneOnline, true, 'a heartbeat of exactly 90 seconds still counts');
  ctx.clock.advance(1);
  assert.equal(ctx.channel.inspect().phoneOnline, false, 'older, and nothing came: the phone is gone');

  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await ctx.until(() => ctx.channel.inspect().phoneOnline, 'the next heartbeat brings it back');
  ctx.clock.advance(PHONE_PRESENCE_TIMEOUT_MS / 2);
  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await tick();
  ctx.clock.advance(PHONE_PRESENCE_TIMEOUT_MS / 2 + 1);
  assert.equal(ctx.channel.inspect().phoneOnline, true, 'each heartbeat starts the 90 seconds over');

  await ctx.relay.phone.setPresence(ctx.channelId, false);
  await ctx.until(() => !ctx.channel.inspect().phoneOnline, 'the record deleted');
});

test('listeners hear of a session and of the phone\'s heartbeat, once per change (#1196)', async (t) => {
  const ctx = await session(t);
  assert.deepEqual(ctx.states, [{ connected: true, phonePresent: false, phoneLastSeen: null }], 'a session, but no phone yet');
  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await ctx.until(() => ctx.states.length === 2, 'the heartbeat heard');
  assert.deepEqual(ctx.states.at(-1), { connected: true, phonePresent: true, phoneLastSeen: null });
  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await tick();
  assert.equal(ctx.states.length, 2, 'a heartbeat that changes nothing is not news');
  const heard = ctx.clock.now();
  ctx.clock.advance(PHONE_PRESENCE_TIMEOUT_MS + 1);
  assert.deepEqual(ctx.states.at(-1), { connected: true, phonePresent: false, phoneLastSeen: heard }, 'stale: the phone is gone, the session stays');
  assert.equal(ctx.channel.isConnected(), true);
});

test('a phone that is away was last seen at its last heartbeat, or when it took its record away (#1233)', async (t) => {
  const ctx = await connected(t);
  const lastSeen = () => ctx.states.at(-1)?.phoneLastSeen ?? null;
  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await ctx.until(() => ctx.channel.inspect().phoneOnline, 'the heartbeat read');
  assert.equal(lastSeen(), null, 'a phone that is there needs no "last seen"');
  const beat = ctx.clock.now();
  ctx.clock.advance(PHONE_PRESENCE_TIMEOUT_MS + 1);
  assert.equal(lastSeen(), beat, 'stale: last seen at its last heartbeat, not when it went stale');

  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await ctx.until(() => ctx.channel.inspect().phoneOnline, 'back again');
  assert.equal(lastSeen(), null);
  ctx.clock.advance(20_000);
  const left = ctx.clock.now();
  // The app goes to the background: the phone deletes its record (§12.3).
  await ctx.relay.phone.setPresence(ctx.channelId, false);
  await ctx.until(() => !ctx.channel.inspect().phoneOnline, 'the record deleted');
  assert.equal(lastSeen(), left, 'it was there until it took its record away');
  const told = ctx.states.length;
  ctx.clock.advance(10 * 60_000);
  assert.equal(ctx.states.length, told, 'time passing is no news; the window says how long ago');
});

test('a link the desktop loses keeps what was seen of the phone; another phone starts from nothing (#1233)', async (t) => {
  const ctx = await connected(t);
  const lastSeen = () => ctx.states.at(-1)?.phoneLastSeen ?? null;
  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await ctx.until(() => ctx.channel.inspect().phoneOnline, 'the heartbeat read');
  const beat = ctx.clock.now();
  ctx.clock.advance(5_000);
  ctx.relay.inspect.dropLinks();
  await ctx.until(() => !ctx.channel.inspect().linked, 'the link to fail');
  assert.equal(lastSeen(), beat, 'the desktop lost the link, the phone did not leave: its last heartbeat');

  await ctx.fixture.pairing.unpair();
  await ctx.channel.refresh();
  assert.equal(lastSeen(), null, 'the phone removed: nothing is kept of it');
});

test('a heartbeat found stale on connecting counts as gone from the start (§12.3, #1227)', async (t) => {
  const ctx = await connected(t);
  await ctx.relay.phone.setPresence(ctx.channelId, true);
  await ctx.until(() => ctx.channel.inspect().phoneOnline, 'the heartbeat read');
  ctx.relay.inspect.dropLinks();
  await ctx.until(() => !ctx.channel.inspect().linked, 'the link to fail');
  ctx.relay.inspect.setReachable(false);
  ctx.clock.advance(PHONE_PRESENCE_TIMEOUT_MS);
  await ctx.until(() => ctx.fixture.log.lines.filter((line) => line.includes('the channel failed')).length >= 2, 'a second failure');
  ctx.relay.inspect.setReachable(true);
  ctx.clock.advance(60_000);
  await ctx.until(() => ctx.channel.inspect().live, 'connected again');
  assert.ok(ctx.relay.inspect.nodes(ctx.channelId).presence.phone, 'the old record is still there');
  assert.equal(ctx.channel.inspect().phoneOnline, false, 'but it is too old to count');
});

test('handshake 2 answers handshake 1, and session.hello mints a relay connection (§13, §17)', async (t) => {
  const ctx = await session(t);
  const { message } = ctx.hello;
  assert.equal(ctx.hello.counter, 0);
  assert.equal(ctx.hello.sid, ctx.mobile.sid);
  assert.equal(message.id, 1);
  assert.equal(message.result.protocol, 1);
  assert.equal(message.result.kind, 'relay');
  assert.equal(message.result.connectionId, 'conn-1');
  assert.deepEqual(message.result.app, { version: '9.9.9' });
  // The stand-in behind the port until #1194: nothing beyond the session's own methods.
  assert.deepEqual(message.result.methods, ['session.hello', 'session.bye']);
  assert.deepEqual(message.result.approvalResponses, []);
  assert.equal(message.result.limits.maxRequestBytes, 256 * 1024);

  assert.equal(ctx.channel.isConnected(), true);
  assert.deepEqual(ctx.states.at(-1), { connected: true, phonePresent: false, phoneLastSeen: null });
  assert.deepEqual(inbox(ctx), {}, 'the envelope was deleted once handled');
});

test('any method before session.hello gets connection-unknown, and no connection is counted', async (t) => {
  const ctx = await connected(t);
  await ctx.mobile.handshake({ until: ctx.until });
  await ctx.mobile.send({ jsonrpc: '2.0', id: 7, method: 'chats.list', params: {} });
  const [{ message }] = await nextAnswers(ctx);
  assert.equal(message.id, 7);
  assert.equal(message.error.code, REMOTE_RPC_ERRORS['connection-unknown']);
  assert.equal(message.error.data.reason, 'connection-unknown');
  assert.deepEqual(message.error.data.message, { key: 'remote.rpc.error.connection-unknown' });
  assert.equal(ctx.channel.isConnected(), false);
});

test('after session.hello every other method reaches the message layer — the stand-in answers unavailable, in the phone\'s language', async (t) => {
  const ctx = await connected(t);
  await ctx.mobile.handshake({ until: ctx.until });
  await ctx.mobile.send({ ...HELLO, params: { ...HELLO.params, locale: 'de' } });
  await nextAnswers(ctx);
  await ctx.mobile.send({ jsonrpc: '2.0', id: 'two', method: 'chats.list', params: {} });
  const [{ counter, message }] = await nextAnswers(ctx);
  assert.equal(counter, 1);
  assert.equal(message.id, 'two');
  assert.equal(message.error.code, REMOTE_RPC_ERRORS.unavailable);
  assert.equal(message.error.message, 'Das gibt es noch nicht.');
});

test('a request the profile does not allow gets an answer all the same', async (t) => {
  const ctx = await session(t);
  await ctx.mobile.send('{ not json');
  await ctx.mobile.send({ jsonrpc: '2.0', method: 'chat.abort', params: {} });
  await ctx.mobile.send({ jsonrpc: '2.0', id: 3, method: 'session.hello', params: HELLO.params });
  const answers = (await nextAnswers(ctx, 3)).map(({ message }) => [message.id, message.error.data.reason]);
  assert.deepEqual(answers, [[null, 'parse'], [null, 'invalid-request'], [3, 'invalid-request']]);
});

test('session.hello with bad params, or no shared version, is refused without a connection', async (t) => {
  const ctx = await connected(t);
  await ctx.mobile.handshake({ until: ctx.until });
  await ctx.mobile.send({ ...HELLO, params: { protocol: [1], client: { name: '' } } });
  await ctx.mobile.send({ ...HELLO, id: 2, params: { ...HELLO.params, protocol: [2] } });
  const [bad, unsupported] = await nextAnswers(ctx, 2);
  assert.equal(bad.message.error.data.reason, 'invalid-params');
  assert.equal(unsupported.message.error.code, REMOTE_RPC_ERRORS['protocol-unsupported']);
  assert.deepEqual(unsupported.message.error.data.protocol, [1]);
  assert.equal(ctx.channel.isConnected(), false);
});

test('a handshake without a shared version gets protocol-unsupported and the desktop\'s list', async (t) => {
  const ctx = await connected(t);
  const answer = await ctx.mobile.handshake({ offered: [2], until: ctx.until });
  assert.deepEqual(answer, { error: 'protocol-unsupported', v: [1] });
});

test('a new handshake 1 ends the session before it', async (t) => {
  const ctx = await session(t);
  const oldSid = ctx.mobile.sid;
  await ctx.mobile.handshake({ until: ctx.until });
  await ctx.until(() => !ctx.channel.isConnected(), 'the old session to end');
  assert.notEqual(ctx.mobile.sid, oldSid);
  assert.deepEqual(ctx.states.at(-1), { connected: false, phonePresent: false, phoneLastSeen: null });
  await ctx.mobile.send(HELLO);
  const [{ message }] = await nextAnswers(ctx);
  assert.equal(message.result.connectionId, 'conn-2', 'a new session is a new connection');
});

test('session.bye is answered and ends the session', async (t) => {
  const ctx = await session(t);
  await ctx.mobile.send({ jsonrpc: '2.0', id: 9, method: 'session.bye', params: {} });
  const [{ message }] = await nextAnswers(ctx);
  assert.deepEqual(message, { jsonrpc: '2.0', id: 9, result: {} });
  assert.equal(ctx.channel.isConnected(), false);
});

// ---------------------------------------------------------------- §16, row by row

test('§16: counter = next is delivered, then every held one that follows on', async (t) => {
  const ctx = await session(t);
  const request = (id) => ({ jsonrpc: '2.0', id, method: 'chats.list', params: {} });
  await ctx.mobile.send(request(3), { counter: 3 });
  await ctx.mobile.send(request(2), { counter: 2 });
  await tick();
  assert.equal(ctx.channel.inspect().session.held, 2, 'held, not delivered');
  await ctx.mobile.send(request(1), { counter: 1 });
  const answers = await nextAnswers(ctx, 3);
  assert.deepEqual(answers.map(({ message }) => message.id), [1, 2, 3], 'delivered in order');
  assert.equal(ctx.channel.inspect().session.next, 4);
  assert.deepEqual(inbox(ctx), {}, 'every envelope deleted once handled');
});

test('§16: a counter already seen, or already held, is dropped as a replay', async (t) => {
  const ctx = await session(t);
  const sealed = await ctx.mobile.send({ jsonrpc: '2.0', id: 5, method: 'chats.list', params: {} }, { counter: 5 });
  await tick();
  // The relay refuses an overwrite, so the replay arrives as a fresh record after the first was deleted.
  await ctx.until(() => Object.keys(inbox(ctx)).length === 0, 'the held envelope deleted');
  await ctx.mobile.send(null, { counter: 5, sealed });
  await tick();
  assert.equal(ctx.channel.inspect().session.held, 1, 'held once');
  // Counter 0, session.hello, again: below next.
  await ctx.until(() => Object.keys(inbox(ctx)).length === 0, 'the replay deleted');
  await ctx.mobile.send(HELLO, { counter: 0 });
  await tick();
  assert.equal(ctx.channel.isConnected(), true, 'a replay changes nothing');
  assert.deepEqual(ctx.mobile.receive(), []);
});

test('§16: a gap not filled within 5 seconds starts over', async (t) => {
  const ctx = await session(t);
  await ctx.mobile.send({ jsonrpc: '2.0', id: 2, method: 'chats.list', params: {} }, { counter: 2 });
  await ctx.until(() => ctx.channel.inspect().session?.held === 1, 'held');
  ctx.clock.advance(HOLD_MS - 1);
  assert.equal(ctx.channel.isConnected(), true);
  ctx.clock.advance(1);
  assert.equal(ctx.channel.isConnected(), false, 'the session ended');
  assert.equal(ctx.channel.inspect().session, null);
});

test('§16: a counter more than 32 ahead starts over', async (t) => {
  const ctx = await session(t);
  await ctx.mobile.send({ jsonrpc: '2.0', id: 40, method: 'chats.list', params: {} }, { counter: 1 + 33 });
  await ctx.until(() => !ctx.channel.isConnected(), 'the session to end');
  assert.ok(ctx.fixture.log.lines.some((line) => line.includes('starts over (jump)')));
});

test('§16: a tag that does not verify is dropped and the session starts over', async (t) => {
  const ctx = await session(t);
  const good = Buffer.from(await ctx.mobile.send({ jsonrpc: '2.0', id: 2, method: 'chats.list', params: {} }, { counter: 2 }), 'base64url');
  await ctx.until(() => ctx.channel.inspect().session?.held === 1, 'held');
  good[0] ^= 1;
  await ctx.mobile.send(null, { counter: 1, sealed: good.toString('base64url') });
  await ctx.until(() => !ctx.channel.isConnected(), 'the session to end');
  assert.ok(ctx.fixture.log.lines.some((line) => line.includes('starts over (tag)')));
  await ctx.until(() => Object.keys(inbox(ctx)).length === 0, 'both deleted');
});

test('§16: another sid is ignored and deleted', async (t) => {
  const ctx = await session(t);
  await ctx.mobile.send({ jsonrpc: '2.0', id: 2, method: 'chats.list', params: {} }, { counter: 1, sid: '00000000000000aa' });
  await ctx.until(() => Object.keys(inbox(ctx)).length === 0, 'the foreign envelope deleted');
  assert.equal(ctx.channel.isConnected(), true);
  assert.equal(ctx.channel.inspect().session.next, 1);
  assert.deepEqual(ctx.mobile.receive(), []);
});

test('a session ends after 24 hours', async (t) => {
  const ctx = await session(t);
  ctx.clock.advance(SESSION_MAX_MS);
  assert.equal(ctx.channel.isConnected(), false);
});

// ---------------------------------------------------------------- the link

test('a vanishing meta ends the channel and the phone is forgotten (§12.2)', async (t) => {
  const ctx = await session(t);
  await ctx.relay.phone.deleteChannel(ctx.channelId);
  await ctx.until(() => ctx.gone.length === 1, 'onGone');
  assert.deepEqual(ctx.gone, [ctx.channelId]);
  assert.equal(ctx.channel.isConnected(), false);
  assert.equal(ctx.channel.inspect().linked, false);
  // Wired as the bridge wires it, the pairing forgets the phone.
  await ctx.fixture.pairing.forgetChannel(ctx.channelId);
  assert.equal((await ctx.fixture.pairing.getState()).state, 'empty');
  ctx.clock.advance(10 * 60_000);
  assert.equal(ctx.relay.inspect.links(), 0, 'and it does not connect again');
});

test('after a network loss the channel connects again, with a growing pause', async (t) => {
  const ctx = await session(t);
  ctx.relay.inspect.dropLinks();
  await ctx.until(() => !ctx.channel.inspect().linked, 'the link to fail');
  assert.equal(ctx.channel.isConnected(), false, 'the session goes with the link');
  ctx.relay.inspect.setReachable(false);
  ctx.clock.advance(2_000);
  await ctx.until(() => ctx.fixture.log.lines.filter((line) => line.includes('the channel failed')).length >= 2, 'a second failure');
  ctx.relay.inspect.setReachable(true);
  ctx.clock.advance(2_000);
  await tick();
  assert.equal(ctx.channel.inspect().linked, false, 'the second pause is longer');
  ctx.clock.advance(2_000);
  await ctx.until(() => ctx.channel.inspect().live, 'connected again');
  // The phone starts a new handshake when the desktop's presence comes back.
  await ctx.mobile.handshake({ until: ctx.until });
  await ctx.mobile.send(HELLO);
  const [{ message }] = await nextAnswers(ctx);
  assert.equal(message.result.kind, 'relay');
});

test('removing the phone closes the channel', async (t) => {
  const ctx = await session(t);
  await ctx.fixture.pairing.unpair();
  await ctx.channel.refresh();
  assert.equal(ctx.channel.inspect().linked, false);
  assert.equal(ctx.channel.isConnected(), false);
});

test('wired as the bridge: the panel learns the connection, and a channel the phone removed forgets the phone', async (t) => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const { createRemoteBridge } = require('../src/main/composition/create-remote-bridge');
  const { createInMemoryRelayAdapter } = require('../src/main/remote/in-memory-relay-adapter');
  const { createConfirmationReceipts } = require('../src/application/permissions/user-confirmation');
  const { createNativeConfirmationAdapter } = require('../src/main/electron/native-confirmation-adapter');
  const { createFakeDialog, createFakeSafeStorage, createLog, createPhone, tempDir } = require('./helpers/remote-pairing');

  const relay = createInMemoryRelayAdapter({ relayHost: 'relay.test' });
  const dialog = createFakeDialog();
  const registry = createConfirmationReceipts();
  const held = new Set();
  let handles = 0;
  const powerSave = { hold: () => { held.add(++handles); return handles; }, release: (handle) => held.delete(handle) };
  const bridge = createRemoteBridge({
    // Pairing is closed in this build until the phone's side is out (#1110); these tests pair.
    pairingOpen: true,
    userDataPath: tempDir(t),
    secretStore: createFakeSafeStorage(),
    fs: fsp,
    path,
    confirmations: createNativeConfirmationAdapter({ dialog, receipts: { issue: registry.issue } }),
    receipts: { redeem: registry.redeem },
    getLocale: () => 'en',
    getAppVersion: () => '1.2.3',
    relay,
    powerSave,
    log: createLog(),
  });
  t.after(() => bridge.dispose());
  const states = [];
  bridge.pairing.subscribe((state) => states.push(state));
  const until = async (predicate, what) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(states.at(-1))}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  await bridge.start();
  assert.equal(relay.inspect.links(), 0, 'nothing to connect to yet');

  // Pairing a phone connects the channel, without a restart.
  const phone = createPhone();
  await bridge.pairing.start();
  const shown = await until(() => states.find((s) => s.state === 'code'), 'the code');
  const channelId = await phone.claim(relay, shown.code.display);
  await until(() => dialog.open().length, 'the sheet');
  dialog.open()[0].allow();
  await until(() => relay.inspect.links() === 1 && relay.inspect.nodes(channelId)?.presence.desktop, 'the channel to connect');

  // A phone that came and went before any session: the panel says when it was last there (#1233).
  assert.equal(states.at(-1)?.phone?.lastSeen, null, 'nothing seen yet');
  await relay.phone.setPresence(channelId, true);
  const before = Date.now();
  await relay.phone.setPresence(channelId, false);
  const seen = await until(() => states.at(-1)?.phone?.lastSeen, 'the panel to learn when the phone was last there');
  assert.ok(seen >= before && seen <= Date.now());

  const mobile = createChannelPhone(relay, phone, channelId, relay.inspect.record(channelId).desktopKeys);
  await mobile.handshake({ until });
  await mobile.send(HELLO);
  const [answer] = await until(() => {
    const got = mobile.receive();
    return got.length ? got : null;
  }, 'the answer to session.hello');
  assert.equal(answer.message.result.app.version, '1.2.3');
  assert.equal(states.at(-1)?.phone?.connected, false, 'a session alone is not connected — the phone is not there (#1196)');
  await relay.phone.setPresence(channelId, true);
  await until(() => states.at(-1)?.phone?.connected === true, 'the panel to say connected');
  assert.equal(states.at(-1).phone.lastSeen, null, 'a connected phone needs no "last seen"');
  // A run that works while the phone is connected keeps the computer awake (#1196).
  assert.deepEqual(bridge.presence.getState(), { connected: true, keepingAwake: false });
  bridge.presence.setWorking(true);
  assert.deepEqual(bridge.presence.getState(), { connected: true, keepingAwake: true });
  assert.equal(held.size, 1);

  await relay.phone.deleteChannel(channelId);
  await until(() => states.at(-1)?.state === 'empty', 'the phone forgotten');
  assert.equal(relay.inspect.links(), 0);
  // A phone that is gone is not held for the grace, and lets the computer sleep.
  assert.deepEqual(bridge.presence.getState(), { connected: false, keepingAwake: false });
  assert.equal(held.size, 0);
});
