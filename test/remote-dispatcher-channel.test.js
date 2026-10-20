'use strict';

// The dispatcher (#1194) behind the real channel (#1192): a paired phone,
// with its half computed by the reference implementation, says hello over
// the in-memory relay, learns the methods of step 1, lists and opens a chat
// and follows a running turn — the deltas batched into one envelope every
// 150 ms (docs/remote-protocol.md §17).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRemoteDispatcher } = require('../src/application/remote/remote-dispatcher');
const { translateMessage } = require('../src/shared/i18n');
const { HELLO, createChannelFixture, createChannelPhone, pairedFixture } = require('./helpers/remote-channel');

const ROOT = '/home/user/projects/alpha';

/** A desktop with one released workspace and one chat in it. */
function fakes() {
  const listeners = new Set();
  const desktop = {
    knownWorkspaces: async () => [ROOT],
    activeWorkspace: () => ROOT,
    listChats: async (roots) => (roots.includes(ROOT) ? [{ chatId: 'c1', root: ROOT, title: 'Release notes', updatedAt: 5, messageCount: 2 }] : []),
    loadChat: async (chatId) => (chatId === 'c1'
      ? { chatId, root: ROOT, title: 'Release notes', updatedAt: 5, messages: [{ role: 'user', content: 'Draft them' }, { role: 'assistant', content: 'Here.' }] }
      : null),
    runningChats: () => new Set(),
    awaitingApproval: () => new Set(),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const releases = {
    isAvailable: () => true,
    list: async () => [{ workspaceId: 'ws-1', root: ROOT }],
    release: async () => ({ ok: false, reason: 'unconfirmed' }),
    withdraw: async () => {},
    subscribe: () => () => {},
  };
  return { desktop, releases, emit: (activity) => { for (const l of listeners) l(activity); } };
}

async function phoneSession(t) {
  const paired = await pairedFixture(t);
  const { fixture, phone, channelId, desktopKeys } = paired;
  const { desktop, releases, emit } = fakes();
  const dispatcher = createRemoteDispatcher({
    desktop, releases, word: translateMessage, deltaBatchMs: 150,
    setTimer: fixture.clock.setTimer, clearTimer: fixture.clock.clearTimer, log: fixture.log,
  });
  const harness = createChannelFixture(t, paired, { messages: dispatcher });
  await harness.channel.start();
  await fixture.until(() => harness.channel.inspect().live, 'the channel to stand');
  const mobile = createChannelPhone(fixture.relay, phone, channelId, desktopKeys);
  await mobile.handshake({ until: fixture.until });
  await mobile.send(HELLO);

  const received = [];
  /** Waits until the phone has received a message that `predicate` picks. */
  const next = (predicate, what) => fixture.until(() => {
    received.push(...mobile.receive().map((r) => r.message));
    return received.find(predicate) ?? null;
  }, what);
  let ids = 1;
  const request = async (method, params = {}) => {
    const id = (ids += 1);
    await mobile.send({ jsonrpc: '2.0', id, method, params });
    return next((m) => m.id === id, `the answer to ${method}`);
  };
  return { fixture, harness, mobile, emit, received, next, request };
}

test('over the channel, the phone learns the methods of steps 1 and 2 and the state, and reads a chat', async (t) => {
  const ctx = await phoneSession(t);
  const hello = await ctx.next((m) => m.id === 1, 'the answer to session.hello');
  assert.deepEqual(hello.result.methods, [
    'session.hello', 'session.bye', 'workspaces.list', 'chats.list', 'chat.open', 'chat.more', 'chat.close',
    'chat.new', 'message.send', 'run.abort', 'chat.configuration',
  ]);
  assert.deepEqual(hello.result.approvalResponses, []);

  const welcome = await ctx.next((m) => m.method === 'session.welcome', 'session.welcome');
  assert.equal(welcome.params.connectionId, hello.result.connectionId);
  const state = await ctx.next((m) => m.method === 'state', 'state');
  assert.deepEqual(state.params, { activeWorkspaceId: 'ws-1', running: [], busy: false });

  const workspaces = await ctx.request('workspaces.list');
  assert.deepEqual(workspaces.result, { workspaces: [{ workspaceId: 'ws-1', name: 'alpha', active: true }] });
  const chats = await ctx.request('chats.list', { workspaceId: 'ws-1' });
  assert.deepEqual(chats.result.chats.map((c) => c.chatId), ['c1']);
  const opened = await ctx.request('chat.open', { chatId: 'c1' });
  assert.deepEqual(opened.result.messages.map((m) => m.text), ['Draft them', 'Here.']);
  assert.ok(!JSON.stringify(ctx.received).includes(ROOT), 'no path reached the phone');
});

test('over the channel, a running turn\'s text arrives batched, in order with its other events', async (t) => {
  const ctx = await phoneSession(t);
  await ctx.request('chat.open', { chatId: 'c1' });
  const run = (type, payload) => ctx.emit({ kind: 'run', chatId: 'c1', runId: 'r1', type, payload });
  run('delta', { text: 'Hel' });
  run('delta', { text: 'lo' });
  ctx.fixture.clock.advance(150);
  const delta = await ctx.next((m) => m.method === 'chat.delta', 'chat.delta');
  assert.deepEqual(delta.params, { chatId: 'c1', runId: 'r1', text: 'Hello' });

  run('delta', { text: ' again' });
  run('progress', { type: 'run-end' });
  const end = await ctx.next((m) => m.method === 'chat.progress', 'run-end');
  assert.deepEqual(end.params, { chatId: 'c1', runId: 'r1', type: 'run-end' });
  const deltas = ctx.received.filter((m) => m.method === 'chat.delta');
  assert.deepEqual(deltas.map((m) => m.params.text), ['Hello', ' again']);
  assert.ok(ctx.received.indexOf(deltas[1]) < ctx.received.indexOf(end), 'the text comes before the end of its run');
});

test('a session that ends closes the dispatcher\'s connection with it', async (t) => {
  const ctx = await phoneSession(t);
  await ctx.next((m) => m.id === 1, 'the answer to session.hello');
  const bye = await ctx.request('session.bye');
  assert.deepEqual(bye.result, {});
  // The channel ended the session; a new handshake starts a new connection with empty subscriptions.
  await ctx.mobile.handshake({ until: ctx.fixture.until });
  await ctx.mobile.send({ jsonrpc: '2.0', id: 50, method: 'chats.list', params: {} });
  const early = await ctx.next((m) => m.id === 50, 'the answer before hello');
  assert.equal(early.error.data.reason, 'connection-unknown');
});
