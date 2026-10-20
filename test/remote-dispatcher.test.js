'use strict';

// The remote dispatcher (#1194), steps 1 and 2 of docs/remote-interface.md
// §10: the methods of §8.1 and the events of §8.2 against a fake desktop and
// release list — what a connection may see (§7.5), how a method is refused
// (§6.3), that nothing it is told carries a path, a tool argument or a chat
// it may not see, and that it writes only in the workspace open at the
// desktop, once per clientMessageId.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRemoteDispatcher, DISPATCHER_LIMITS } = require('../src/application/remote/remote-dispatcher');
const { REMOTE_RPC_ERRORS } = require('../src/shared/contracts/remote/rpc-errors');
const { createMessage } = require('../src/shared/contracts/message');
const { translateMessage } = require('../src/shared/i18n');
const { DEFAULT_LOCALE } = require('../src/shared/i18n/locales');

const ALPHA = '/home/user/projects/alpha';
const BETA = '/home/user/projects/beta';
const HIDDEN = '/home/user/projects/hidden';

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** @param {string} chatId @param {string} root @param {number} updatedAt @param {object[]} [messages] */
const chat = (chatId, root, updatedAt, messages = [], title = `Chat ${chatId}`) => ({ chatId, root, title, updatedAt, messages });

function fakeDesktop({ known = [ALPHA, BETA, HIDDEN], active = ALPHA, chats = [] } = {}) {
  const listeners = new Set();
  const state = { known, active, chats, running: new Set(), awaiting: new Set(), loads: [], turns: [], stops: [], available: true };
  return {
    state,
    port: {
      knownWorkspaces: async () => [...state.known],
      activeWorkspace: () => state.active,
      listChats: async (roots) => state.chats
        .filter((c) => roots.includes(c.root))
        .map(({ messages, ...row }) => ({ ...row, messageCount: messages.length })),
      loadChat: async (chatId) => {
        state.loads.push(chatId);
        const found = state.chats.find((c) => c.chatId === chatId);
        return found ? { ...found } : null;
      },
      runningChats: () => state.running,
      awaitingApproval: () => state.awaiting,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      startTurn: async (turn) => {
        if (!state.available) return { ok: false, reason: 'unavailable' };
        state.turns.push(turn);
        return { ok: true };
      },
      stopChat: (chatId) => {
        state.stops.push(chatId);
        return state.running.has(chatId);
      },
      chatConfiguration: async (chatId, root) => ({
        model: { label: `model of ${chatId}` },
        mode: 'smart',
        reasoning: root === ALPHA ? 'high' : null,
        skills: [{ name: 'docs', state: 'on' }],
        tools: [{ name: 'shell_execute', on: false }],
      }),
    },
    emit: (activity) => { for (const listener of listeners) listener(activity); },
    listeners,
  };
}

function fakeReleases(entries = [{ workspaceId: 'id-alpha', root: ALPHA }, { workspaceId: 'id-beta', root: BETA }]) {
  const listeners = new Set();
  let list = [...entries];
  return {
    port: {
      isAvailable: () => true,
      list: async () => [...list],
      release: async () => ({ ok: false, reason: 'unconfirmed' }),
      withdraw: async (root) => {
        list = list.filter((entry) => entry.root !== root);
        for (const listener of listeners) listener();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    listeners,
  };
}

function manualTimers() {
  const queue = [];
  return {
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      queue.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const at = queue.indexOf(timer);
      if (at >= 0) queue.splice(at, 1);
    },
    fire() {
      for (const timer of queue.splice(0)) timer.fn();
    },
    queue,
  };
}

/**
 * A dispatcher on fakes, with one connection open whose events are recorded.
 * @param {object} [options]
 */
async function setup({ desktop = fakeDesktop(), releases = fakeReleases(), kind = 'relay', deltaBatchMs = 0, timers = manualTimers(), open = true } = {}) {
  const warnings = [];
  let uuids = 0;
  const dispatcher = createRemoteDispatcher({
    desktop: desktop.port,
    releases: releases.port,
    word: translateMessage,
    randomUUID: () => `uuid-${(uuids += 1)}`,
    deltaBatchMs,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    log: { warn: (line) => warnings.push(String(line)) },
  });
  const connection = Object.freeze({ id: 'conn-1', kind, client: { name: 'test', version: '1' }, locale: DEFAULT_LOCALE, capabilities: [] });
  const events = [];
  const outlet = { accept: true, send: (event) => { events.push(event); return outlet.accept; } };
  if (open) dispatcher.open(connection, outlet);
  await settle();
  let ids = 0;
  const call = (method, params = {}) => dispatcher.handle(connection, { id: (ids += 1), method, params });
  const named = (method) => events.filter((e) => e.method === method).map((e) => e.params);
  return { dispatcher, connection, events, outlet, call, named, desktop, releases, timers, warnings };
}

/** @param {object} answer @param {string} reason */
function assertError(answer, reason) {
  assert.ok(answer.error, `expected an error, got ${JSON.stringify(answer)}`);
  assert.equal(answer.error.code, REMOTE_RPC_ERRORS[reason]);
  assert.equal(answer.error.data.reason, reason);
  assert.equal(typeof answer.error.message, 'string');
}

const noPaths = (value) => {
  const text = JSON.stringify(value);
  for (const root of [ALPHA, BETA, HIDDEN, '/home/user']) assert.ok(!text.includes(root), `a path in ${text}`);
};

test('session.hello learns the methods to watch and to write, no approval answers and the limits', async () => {
  const { dispatcher, connection } = await setup({ open: false });
  assert.deepEqual(dispatcher.describe(connection), {
    methods: [
      'workspaces.list', 'chats.list', 'chat.open', 'chat.more', 'chat.close',
      'chat.new', 'message.send', 'run.abort', 'chat.configuration',
    ],
    approvalResponses: [],
    limits: { ...DISPATCHER_LIMITS },
  });
  assert.deepEqual(dispatcher.describe({ ...connection, kind: 'desktop' }).methods, [], 'the window keeps IPC');
});

test('a connection that opens is welcomed, then told the state', async () => {
  const { events } = await setup();
  assert.deepEqual(events.map((e) => e.method), ['session.welcome', 'state']);
  assert.deepEqual(events[0].params, { connectionId: 'conn-1', seq: 0 });
  assert.deepEqual(events[1].params, { activeWorkspaceId: 'id-alpha', running: [], busy: false });
  for (const event of events) assert.equal(event.jsonrpc, '2.0');
});

test('workspaces.list names the released folders the desktop knows, never their paths', async () => {
  const desktop = fakeDesktop({ known: [ALPHA, HIDDEN], active: HIDDEN });
  const { call } = await setup({ desktop });
  const answer = await call('workspaces.list');
  // BETA is released but no longer known; HIDDEN is known but not released.
  assert.deepEqual(answer.result, { workspaces: [{ workspaceId: 'id-alpha', name: 'alpha', active: false }] });
  noPaths(answer);
});

test('chats.list pages the visible chats, newest first, with their state', async () => {
  const desktop = fakeDesktop({
    chats: [
      chat('a1', ALPHA, 300), chat('a2', ALPHA, 100), chat('b1', BETA, 200),
      chat('h1', HIDDEN, 999), { ...chat('a3', ALPHA, 50), title: createMessage('chat.title.new') },
    ],
  });
  desktop.state.running = new Set(['a1', 'b1']);
  desktop.state.awaiting = new Set(['b1']);
  const { call } = await setup({ desktop });

  const first = await call('chats.list', { limit: 2 });
  assert.deepEqual(first.result.chats.map((c) => [c.chatId, c.state]), [['a1', 'running'], ['b1', 'needs-approval']]);
  assert.equal(typeof first.result.before, 'string');
  const second = await call('chats.list', { limit: 2, before: first.result.before });
  assert.deepEqual(second.result.chats.map((c) => c.chatId), ['a2', 'a3']);
  assert.equal(second.result.before, undefined);
  assert.equal(second.result.chats[1].title, translateMessage(DEFAULT_LOCALE, createMessage('chat.title.new')));
  assert.deepEqual(Object.keys(second.result.chats[0]).sort(), ['chatId', 'messageCount', 'state', 'title', 'updatedAt']);

  const alpha = await call('chats.list', { workspaceId: 'id-alpha' });
  assert.deepEqual(alpha.result.chats.map((c) => c.chatId), ['a1', 'a2', 'a3']);
  noPaths([first, second, alpha]);
});

test('chats.list refuses a workspace it may not see as it refuses an unknown one, and bad params', async () => {
  const { call } = await setup();
  assertError(await call('chats.list', { workspaceId: 'id-hidden' }), 'not-found');
  assertError(await call('chats.list', { workspaceId: 42 }), 'not-found');
  assertError(await call('chats.list', { limit: 0 }), 'invalid-params');
  assertError(await call('chats.list', { limit: 201 }), 'invalid-params');
  assertError(await call('chats.list', { before: 'not a cursor' }), 'invalid-params');
});

test('chat.open shows the latest messages as the desktop shows them, and nothing else', async () => {
  const messages = [
    { role: 'user', content: 'Look at this', attachments: [{ kind: 'image', mediaType: 'image/png', file: 'secret-file-name.png', name: 'chart.png' }] },
    {
      role: 'assistant',
      content: 'Done.',
      toolTrace: [
        'Read README.md',
        { line: 'Wrote notes.md', tool: 'write_file', args: { path: `${ALPHA}/notes.md`, content: 'TOP SECRET' }, schema: { x: 1 }, sandboxLive: [{ host: 'x' }] },
      ],
      reasoningText: 'my private reasoning',
      streaming: false,
      isError: false,
    },
    { role: 'user', content: 'Again' },
    { role: 'assistant', content: 'Cut off', toolTrace: [], interrupted: true },
  ];
  const desktop = fakeDesktop({ chats: [chat('a1', ALPHA, 10, messages)] });
  const { call } = await setup({ desktop });

  const opened = await call('chat.open', { chatId: 'a1', limit: 3 });
  assert.deepEqual(opened.result, {
    chatId: 'a1',
    title: 'Chat a1',
    state: 'idle',
    messages: [
      {
        messageId: 'm1', role: 'assistant', text: 'Done.',
        toolLines: [{ line: 'Read README.md', tool: null, status: 'done' }, { line: 'Wrote notes.md', tool: 'write_file', status: 'done' }],
      },
      { messageId: 'm2', role: 'user', text: 'Again' },
      { messageId: 'm3', role: 'assistant', text: 'Cut off', interrupted: true },
    ],
    before: 'm1',
    pendingApprovals: [],
  });
  const more = await call('chat.more', { chatId: 'a1', before: 'm1' });
  assert.deepEqual(more.result, {
    messages: [{ messageId: 'm0', role: 'user', text: 'Look at this', attachments: [{ kind: 'image', placeholder: true, name: 'chart.png' }] }],
  });
  const text = JSON.stringify([opened, more]);
  for (const secret of ['TOP SECRET', 'secret-file-name', 'my private reasoning', 'schema', 'sandbox', ALPHA]) {
    assert.ok(!text.includes(secret), `"${secret}" reached the phone`);
  }
});

test('a chat outside the release answers exactly as one that does not exist', async () => {
  const desktop = fakeDesktop({ chats: [chat('h1', HIDDEN, 10, [{ role: 'user', content: 'hidden' }]), chat('n1', null, 10)] });
  const { call } = await setup({ desktop });
  const hidden = await call('chat.open', { chatId: 'h1' });
  const unknown = await call('chat.open', { chatId: 'zz' });
  const folderless = await call('chat.open', { chatId: 'n1' });
  assertError(hidden, 'not-found');
  assert.deepEqual({ ...hidden, id: 0 }, { ...unknown, id: 0 });
  assert.deepEqual({ ...folderless, id: 0 }, { ...unknown, id: 0 });
  assertError(await call('chat.more', { chatId: 'h1', before: 'm1' }), 'not-found');
  assertError(await call('chat.open', { chatId: '' }), 'invalid-params');
  assertError(await call('chat.open', { chatId: 'x'.repeat(129) }), 'invalid-params');
  assertError(await call('chat.more', { chatId: 'h1', before: 'later' }), 'invalid-params');
});

test('unknown methods, other kinds and stale connections are refused in the shape of §6.3', async () => {
  const { call, dispatcher, connection } = await setup();
  assertError(await call('approval.respond', { requestId: 'r1', response: 'allow-once' }), 'unknown-method');
  assertError(await call('toString'), 'unknown-method');
  assertError(await call('__proto__'), 'unknown-method');
  const window = await setup({ kind: 'desktop' });
  assertError(await window.call('chats.list'), 'refused');
  assertError(await dispatcher.handle({ ...connection, id: 'stale' }, { id: 9, method: 'chats.list', params: {} }), 'connection-unknown');
});

test('a method that fails says internal, and nothing of what it was asked', async () => {
  const desktop = fakeDesktop();
  desktop.port.listChats = async () => { throw new Error(`EACCES ${ALPHA}`); };
  const { call, warnings } = await setup({ desktop });
  const answer = await call('chats.list');
  assertError(answer, 'internal');
  noPaths(answer);
  assert.deepEqual(warnings, ['[remote] chats.list failed (Error)']);
});

test('events of a turn reach the connections following its chat, without arguments', async () => {
  const desktop = fakeDesktop({ chats: [chat('a1', ALPHA, 10), chat('a2', ALPHA, 20)] });
  const { call, named, events } = await setup({ desktop });
  await call('chat.open', { chatId: 'a1' });
  const run = (chatId, type, payload) => desktop.emit({ kind: 'run', chatId, runId: 'r1', type, payload });

  run('a1', 'delta', { text: 'Hel' });
  run('a1', 'delta', { text: 'lo' });
  run('a2', 'delta', { text: 'not followed' });
  run('a1', 'tool-line', {
    phase: 'done', line: 'Wrote notes.md', tool: 'write_file', callIndex: 2, args: { path: `${ALPHA}/notes.md` },
    permission: { decision: 'allowed', source: 'rule', rule: 'secret-rule' },
    changes: [{ id: 'ab-1', relativePath: 'notes.md', status: 'text', created: true, added: 3, removed: 0 }],
  });
  run('a1', 'progress', { type: 'chat-saved', ok: true });
  run('a1', 'progress', { type: 'phase', phase: 'thinking' });
  run('a1', 'progress', { type: 'run-end' });

  assert.deepEqual(named('chat.delta'), [{ chatId: 'a1', runId: 'r1', text: 'Hel' }, { chatId: 'a1', runId: 'r1', text: 'lo' }]);
  assert.deepEqual(named('chat.tool-line'), [{
    chatId: 'a1', runId: 'r1', phase: 'done', line: 'Wrote notes.md', callIndex: 2, tool: 'write_file',
    permission: { decision: 'allowed', source: 'rule' },
    changes: [{ relativePath: 'notes.md', status: 'text', added: 3, removed: 0 }],
  }]);
  assert.deepEqual(named('chat.progress'), [
    { chatId: 'a1', runId: 'r1', type: 'phase', phase: 'thinking' },
    { chatId: 'a1', runId: 'r1', type: 'run-end' },
  ]);
  noPaths(events);

  await call('chat.close', { chatId: 'a1' });
  run('a1', 'delta', { text: 'after close' });
  assert.equal(named('chat.delta').length, 2);
});

test('on the relay, streamed text is batched per chat and sent before what follows it', async () => {
  const desktop = fakeDesktop({ chats: [chat('a1', ALPHA, 10)] });
  const timers = manualTimers();
  const { call, named, events } = await setup({ desktop, deltaBatchMs: 150, timers });
  await call('chat.open', { chatId: 'a1' });
  const run = (type, payload, runId = 'r1') => desktop.emit({ kind: 'run', chatId: 'a1', runId, type, payload });

  run('delta', { text: 'a' });
  run('delta', { text: 'b' });
  assert.equal(named('chat.delta').length, 0);
  assert.deepEqual(timers.queue.map((t) => t.ms), [150]);
  timers.fire();
  assert.deepEqual(named('chat.delta'), [{ chatId: 'a1', runId: 'r1', text: 'ab' }]);

  run('delta', { text: 'c' });
  run('tool-line', { phase: 'start', line: 'Reading' });
  const order = events.filter((e) => e.method.startsWith('chat.')).map((e) => e.method);
  assert.deepEqual(order.slice(-2), ['chat.delta', 'chat.tool-line']);
  assert.equal(timers.queue.length, 0, 'the timer of a flushed batch is cleared');

  run('delta', { text: 'old run' }, 'r1');
  run('delta', { text: 'new run' }, 'r2');
  assert.deepEqual(named('chat.delta').slice(-1), [{ chatId: 'a1', runId: 'r1', text: 'old run' }]);
});

test('state follows turns and the open workspace, and says nothing of a hidden one', async () => {
  const desktop = fakeDesktop({ chats: [chat('a1', ALPHA, 10), chat('h1', HIDDEN, 10)] });
  const { named } = await setup({ desktop });

  desktop.state.running = new Set(['h1']);
  desktop.emit({ kind: 'run', chatId: 'h1', runId: null, type: 'delta', payload: { text: 'x' } });
  await settle();
  assert.deepEqual(named('state').at(-1), { activeWorkspaceId: 'id-alpha', running: [], busy: true });

  desktop.state.running = new Set(['h1', 'a1']);
  desktop.emit({ kind: 'run', chatId: 'a1', runId: 'r', type: 'progress', payload: { type: 'phase', phase: 'x' } });
  await settle();
  assert.deepEqual(named('state').at(-1), { activeWorkspaceId: 'id-alpha', running: [{ chatId: 'a1', workspaceId: 'id-alpha', state: 'running' }], busy: true });

  desktop.state.running = new Set();
  desktop.emit({ kind: 'run', chatId: 'a1', runId: 'r', type: 'progress', payload: { type: 'run-end' } });
  desktop.emit({ kind: 'run', chatId: 'h1', runId: null, type: 'progress', payload: { type: 'run-end' } });
  await settle();
  assert.deepEqual(named('state').at(-1), { activeWorkspaceId: 'id-alpha', running: [], busy: false });

  const before = named('state').length;
  desktop.state.active = HIDDEN;
  desktop.emit({ kind: 'workspace' });
  await settle();
  assert.deepEqual(named('state').at(-1), { activeWorkspaceId: null, running: [], busy: false });
  desktop.emit({ kind: 'workspace' });
  await settle();
  assert.equal(named('state').length, before + 1, 'a state that did not change is not said again');
  noPaths(named('state'));
});

test('a workspace withdrawn from the release ends what follows its chats', async () => {
  const desktop = fakeDesktop({ chats: [chat('b1', BETA, 10)] });
  const releases = fakeReleases();
  const { call, named } = await setup({ desktop, releases });
  await call('chat.open', { chatId: 'b1' });
  await releases.port.withdraw(BETA);
  await settle();
  desktop.emit({ kind: 'run', chatId: 'b1', runId: 'r', type: 'delta', payload: { text: 'gone' } });
  assert.equal(named('chat.delta').length, 0);
  assertError(await call('chat.open', { chatId: 'b1' }), 'not-found');
});

test('an event the transport cannot carry is followed by session.resync', async () => {
  const desktop = fakeDesktop({ chats: [chat('a1', ALPHA, 10)] });
  const { call, named, outlet } = await setup({ desktop });
  await call('chat.open', { chatId: 'a1' });
  outlet.accept = false;
  desktop.emit({ kind: 'run', chatId: 'a1', runId: 'r', type: 'delta', payload: { text: 'x'.repeat(10) } });
  assert.deepEqual(named('session.resync'), [{ reason: 'dropped' }]);
});

test('closeAll tells every connection why; close stops listening once none is left', async () => {
  const desktop = fakeDesktop({ chats: [chat('a1', ALPHA, 10)] });
  const timers = manualTimers();
  const { dispatcher, connection, call, named } = await setup({ desktop, deltaBatchMs: 150, timers });
  await call('chat.open', { chatId: 'a1' });
  desktop.emit({ kind: 'run', chatId: 'a1', runId: 'r', type: 'delta', payload: { text: 'last words' } });
  dispatcher.closeAll('quit');
  assert.deepEqual(named('chat.delta'), [{ chatId: 'a1', runId: 'r', text: 'last words' }]);
  assert.deepEqual(named('session.closing'), [{ reason: 'quit' }]);
  assert.equal(desktop.listeners.size, 1);
  dispatcher.close(connection, 'bye');
  assert.equal(desktop.listeners.size, 0);
  assertError(await call('chats.list'), 'connection-unknown');
});

test('chat.open never changes the chat on the desktop\'s screen', async () => {
  const desktop = fakeDesktop({ chats: [chat('a1', ALPHA, 10)] });
  const { call } = await setup({ desktop });
  await call('chat.open', { chatId: 'a1' });
  // The fake port has no way to activate a chat; the dispatcher only loaded it.
  assert.deepEqual(desktop.state.loads, ['a1']);
  assert.equal(desktop.state.active, ALPHA);
});

// ---------------------------------------------------------------- step 2: writing

const turnChats = () => [
  chat('a1', ALPHA, 300, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }]),
  chat('b1', BETA, 200, [{ role: 'user', content: 'in beta' }]),
  chat('h1', HIDDEN, 100, [{ role: 'user', content: 'hidden' }]),
];

test('message.send starts a turn in a chat of the open workspace and answers with its run and message', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call } = await setup({ desktop });
  const answer = await call('message.send', { chatId: 'a1', text: 'next question', clientMessageId: 'c-1' });
  assert.deepEqual(answer.result, { runId: 'uuid-1', messageId: 'm2' });
  // The text and the chat, never a history, a path or a model (§8.1).
  assert.deepEqual(desktop.state.turns, [{ connectionId: 'conn-1', chatId: 'a1', text: 'next question', runId: 'uuid-1' }]);
});

test('a repeated clientMessageId answers again and starts nothing, also on another connection', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call, dispatcher, connection } = await setup({ desktop });
  const first = await call('message.send', { chatId: 'a1', text: 'once', clientMessageId: 'c-1' });
  const again = await call('message.send', { chatId: 'a1', text: 'once', clientMessageId: 'c-1' });
  assert.deepEqual(again.result, first.result);
  const other = { ...connection, id: 'conn-2' };
  dispatcher.open(other, { send: () => true });
  const reconnected = await dispatcher.handle(other, { id: 1, method: 'message.send', params: { chatId: 'a1', text: 'once', clientMessageId: 'c-1' } });
  assert.deepEqual(reconnected.result, first.result);
  assert.equal(desktop.state.turns.length, 1);
  // The same id for another chat is a client's mistake, not a repeat.
  assertError(await call('message.send', { chatId: 'b1', text: 'once', clientMessageId: 'c-1' }), 'invalid-params');
});

test('message.send is refused outside the open workspace and unknown outside the released ones', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call } = await setup({ desktop });
  // BETA is released but not open at the desktop: its tools would work elsewhere (§7.3).
  assertError(await call('message.send', { chatId: 'b1', text: 'hi', clientMessageId: 'c-1' }), 'refused');
  // HIDDEN is not released: exactly as an unknown chat (§7.5).
  const hidden = await call('message.send', { chatId: 'h1', text: 'hi', clientMessageId: 'c-2' });
  assertError(hidden, 'not-found');
  assert.deepEqual(hidden.error, (await call('message.send', { chatId: 'nope', text: 'hi', clientMessageId: 'c-3' })).error);
  desktop.state.active = BETA;
  assert.ok((await call('message.send', { chatId: 'b1', text: 'hi', clientMessageId: 'c-4' })).result);
  assert.deepEqual(desktop.state.turns.map((t) => t.chatId), ['b1']);
});

test('message.send is busy while the chat runs or waits, and checks its params', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call } = await setup({ desktop });
  desktop.state.running.add('a1');
  assertError(await call('message.send', { chatId: 'a1', text: 'hi', clientMessageId: 'c-1' }), 'busy');
  desktop.state.running.clear();
  desktop.state.awaiting.add('a1');
  assertError(await call('message.send', { chatId: 'a1', text: 'hi', clientMessageId: 'c-2' }), 'busy');
  desktop.state.awaiting.clear();
  assertError(await call('message.send', { chatId: 'a1', text: '   ', clientMessageId: 'c-3' }), 'invalid-params');
  assertError(await call('message.send', { chatId: 'a1', text: 'hi' }), 'invalid-params');
  assertError(await call('message.send', { chatId: 'a1', text: 'hi', clientMessageId: 'x'.repeat(65) }), 'invalid-params');
  assertError(await call('message.send', { chatId: 'a1', text: 'x'.repeat(DISPATCHER_LIMITS.maxTextChars + 1), clientMessageId: 'c-4' }), 'too-large');
  assert.equal(desktop.state.turns.length, 0);
});

test('a second send waits for the first turn of a chat to end, and no provider means unavailable', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call } = await setup({ desktop });
  const first = await call('message.send', { chatId: 'a1', text: 'one', clientMessageId: 'c-1' });
  // The desktop has not reported the turn as running yet; the dispatcher knows it started it.
  assertError(await call('message.send', { chatId: 'a1', text: 'two', clientMessageId: 'c-2' }), 'busy');
  desktop.emit({ kind: 'run', chatId: 'a1', runId: first.result.runId, type: 'progress', payload: { type: 'run-end' } });
  desktop.state.available = false;
  assertError(await call('message.send', { chatId: 'a1', text: 'two', clientMessageId: 'c-2' }), 'unavailable');
  desktop.state.available = true;
  // A refused send is not remembered: the same id may try again.
  assert.ok((await call('message.send', { chatId: 'a1', text: 'two', clientMessageId: 'c-2' })).result);
});

test('chat.new makes a chat in the open workspace that the first send writes into', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call } = await setup({ desktop });
  const made = await call('chat.new');
  assert.deepEqual(made.result, { chatId: 'uuid-1' });
  assert.deepEqual((await call('chat.new', { workspaceId: 'id-alpha' })).result, { chatId: 'uuid-2' });
  assertError(await call('chat.new', { workspaceId: 'id-beta' }), 'refused');
  assertError(await call('chat.new', { workspaceId: 'id-unknown' }), 'not-found');
  const sent = await call('message.send', { chatId: 'uuid-1', text: 'hello', clientMessageId: 'c-1' });
  assert.deepEqual(sent.result, { runId: 'uuid-3', messageId: 'm0' });
  // Not written yet, so not listed either.
  assert.deepEqual((await call('chats.list')).result.chats.map((c) => c.chatId), ['a1', 'b1']);
});

test('chat.new is not-found while the open workspace is not released', async () => {
  const desktop = fakeDesktop({ active: HIDDEN });
  const { call } = await setup({ desktop });
  assertError(await call('chat.new'), 'not-found');
});

test('run.abort stops the turn of a visible chat, and a hidden one is unknown', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call } = await setup({ desktop });
  desktop.state.running.add('b1');
  // Stopping is never a loosening: also in a released workspace not open at the desktop.
  assert.deepEqual((await call('run.abort', { chatId: 'b1' })).result, { aborted: true });
  assert.deepEqual((await call('run.abort', { chatId: 'a1' })).result, { aborted: false });
  assertError(await call('run.abort', { chatId: 'h1' }), 'not-found');
  assert.deepEqual(desktop.state.stops, ['b1', 'a1']);
});

test('chat.configuration describes a visible chat, read only and without paths', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call } = await setup({ desktop });
  const answer = await call('chat.configuration', { chatId: 'a1' });
  assert.deepEqual(answer.result, {
    model: { label: 'model of a1' },
    mode: 'smart',
    reasoning: 'high',
    skills: [{ name: 'docs', state: 'on' }],
    tools: [{ name: 'shell_execute', on: false }],
  });
  assert.equal('reasoning' in (await call('chat.configuration', { chatId: 'b1' })).result, false);
  assertError(await call('chat.configuration', { chatId: 'h1' }), 'not-found');
  noPaths(answer);
});

test('a saved question goes to the other followers as chat.message, marked when a remote asked', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call, dispatcher, connection, named } = await setup({ desktop });
  const otherEvents = [];
  const other = { ...connection, id: 'conn-2', client: { name: 'cli', version: '2' } };
  dispatcher.open(other, { send: (event) => { otherEvents.push(event); return true; } });
  await call('chat.open', { chatId: 'a1' });
  await dispatcher.handle(other, { id: 1, method: 'chat.open', params: { chatId: 'a1' } });

  const sent = await call('message.send', { chatId: 'a1', text: 'from the phone', clientMessageId: 'c-1' });
  desktop.state.chats[0].messages.push({ role: 'user', content: 'from the phone' }, { role: 'assistant', content: '' });
  desktop.emit({ kind: 'run', chatId: 'a1', runId: sent.result.runId, type: 'progress', payload: { type: 'chat-saved', ok: true, problem: null } });
  // The next save of the same turn announces nothing again.
  desktop.emit({ kind: 'run', chatId: 'a1', runId: sent.result.runId, type: 'progress', payload: { type: 'chat-saved', ok: true, problem: null } });
  await settle();
  assert.deepEqual(named('chat.message'), [], 'the connection that asked knows its question');
  const told = otherEvents.filter((e) => e.method === 'chat.message').map((e) => e.params);
  assert.deepEqual(told, [{
    chatId: 'a1',
    message: { messageId: 'm2', role: 'user', text: 'from the phone', origin: { kind: 'relay', client: 'test' } },
  }]);

  // A question asked at the desktop reaches both, without a mark.
  desktop.state.chats[0].messages.push({ role: 'user', content: 'from the desktop' });
  desktop.emit({ kind: 'run', chatId: 'a1', runId: 'desk-1', type: 'progress', payload: { type: 'chat-saved', ok: true, problem: null } });
  // A save that did not go through announces nothing.
  desktop.emit({ kind: 'run', chatId: 'a1', runId: 'desk-2', type: 'progress', payload: { type: 'chat-saved', ok: false, problem: 'failed' } });
  await settle();
  assert.deepEqual(named('chat.message'), [{ chatId: 'a1', message: { messageId: 'm4', role: 'user', text: 'from the desktop' } }]);
});

test('a chat that got its name is chat.updated for its followers, and stays out of the turn events', async () => {
  const desktop = fakeDesktop({ chats: turnChats() });
  const { call, named, events } = await setup({ desktop });
  await call('chat.open', { chatId: 'a1' });
  const before = events.length;
  desktop.emit({ kind: 'run', chatId: 'a1', runId: 'r1', type: 'progress', payload: { type: 'chat-named', title: 'Trip planning' } });
  desktop.emit({ kind: 'run', chatId: 'b1', runId: 'r2', type: 'progress', payload: { type: 'chat-named', title: 'Not followed' } });
  await settle();
  assert.deepEqual(named('chat.updated'), [{ chatId: 'a1', title: 'Trip planning' }]);
  assert.deepEqual(events.slice(before).map((e) => e.method), ['chat.updated'], 'no state, no progress');
});
