'use strict';

// What the remote dispatcher reads of the desktop (#1194): folders named as
// the chat history names them, chats in the port's shape, the ids of running
// chats and open cards, and the activity the window's handlers publish.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createRemoteDesktopAdapter } = require('../src/main/remote/desktop-adapter');
const { createRemoteActivity } = require('../src/main/services/remote-activity');
const { createMessage } = require('../src/shared/contracts/message');

const A = path.resolve('/work/a');
const B = path.resolve('/work/b');
const normalizeRoot = (root) => (typeof root === 'string' && root.trim() ? path.resolve(root.trim()) : null);

function setup({ active = A } = {}) {
  const activity = createRemoteActivity({ log: { warn: () => {} } });
  const adapter = createRemoteDesktopAdapter({
    chatHistory: {
      listForRoots: async (roots) => [{ id: 'c1', workspaceRoot: roots[0], title: 'One', updatedAt: 7, messageCount: 2 }],
      loadForDisplay: async (id) => (id === 'c1' ? { id: 'c1', workspaceRoot: `${B}/`, title: '', updatedAt: 7, messages: [{ role: 'user', content: 'hi' }] } : null),
    },
    workspaceFolderStore: { getValidatedFolderHistory: async () => [`${A}/`, B, '  '] },
    getActiveWorkspaceRoot: () => active,
    normalizeRoot,
    runningChatIds: () => new Set(['c1', null]),
    listPendingApprovals: () => [{ chatId: 'c2' }, { chatId: null }, {}],
    activity,
  });
  return { adapter, activity };
}

test('folders are named alike everywhere, and the open one is among the known', async () => {
  const { adapter } = setup({ active: path.resolve('/work/c') });
  assert.deepEqual(await adapter.knownWorkspaces(), [A, B, path.resolve('/work/c')]);
  assert.equal(adapter.activeWorkspace(), path.resolve('/work/c'));
});

test('chats come in the port\'s shape; an untitled one carries the list\'s descriptor', async () => {
  const { adapter } = setup();
  assert.deepEqual(await adapter.listChats([A]), [{ chatId: 'c1', root: A, title: 'One', updatedAt: 7, messageCount: 2 }]);
  assert.deepEqual(await adapter.loadChat('c1'), {
    chatId: 'c1', root: B, title: createMessage('chat.title.new'), updatedAt: 7, messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(await adapter.loadChat('zz'), null);
});

test('running chats and open cards are sets of chat ids, nothing else', () => {
  const { adapter } = setup();
  assert.deepEqual([...adapter.runningChats()], ['c1']);
  assert.deepEqual([...adapter.awaitingApproval()], ['c2']);
});

test('the activity the handlers publish reaches a subscriber, and a broken one stops no other', () => {
  const { adapter, activity } = setup();
  const heard = [];
  const stopBroken = adapter.subscribe(() => { throw new Error('broken'); });
  const stop = adapter.subscribe((a) => heard.push(a));
  activity.publishRun({ chatId: 'c1', runId: 'r', type: 'delta', payload: { text: 'x' } });
  activity.publishRun({ chatId: null, runId: 'r', type: 'delta', payload: {} });
  activity.workspaceChanged();
  stop();
  stopBroken();
  activity.workspaceChanged();
  assert.deepEqual(heard, [
    { kind: 'run', chatId: 'c1', runId: 'r', type: 'delta', payload: { text: 'x' } },
    { kind: 'workspace' },
  ]);
});

// ---------------------------------------------------------------- step 2: what the dispatcher asks of the desktop

const { remoteSessionId, isRemoteSessionId } = require('../src/main/remote/desktop-adapter');

function writer({ target = { providerId: 'p', model: 'gpt-x', reasoningEffort: 'low' }, invalid = null, turn, windowSeen = [], levels = ['low', 'medium', 'high'], remembered = [], reasoningSeen = [] } = {}) {
  const activity = createRemoteActivity({ log: { warn: () => {} } });
  const runs = [];
  const stops = [];
  const heard = [];
  activity.subscribe((event) => heard.push(event));
  const adapter = createRemoteDesktopAdapter({
    chatHistory: { listForRoots: async () => [], loadForDisplay: async () => null },
    workspaceFolderStore: { getValidatedFolderHistory: async () => [] },
    getActiveWorkspaceRoot: () => A,
    normalizeRoot,
    runningChatIds: () => [],
    listPendingApprovals: () => [],
    activity,
    conversation: {
      runTurn: async (input) => {
        runs.push(input);
        if (turn) return turn(input);
        return {};
      },
      stopChat: (chatId) => { stops.push(chatId); return chatId === 'running'; },
    },
    llm: {
      resolveChatTarget: async () => target,
      validateTarget: async () => invalid,
      reasoningLevelsFor: async () => levels,
    },
    chatMode: async (chatId) => (chatId === 'c-ask' ? 'ask-all' : 'smart'),
    rememberReasoning: async (chatId, level) => { remembered.push({ chatId, level }); return true; },
    describeConfiguration: async ({ workspaceRoot }) => ({
      skills: [{ name: 'docs', state: 'on', description: 'secret text' }, { nope: true }],
      tools: [{ name: 'read_file', on: true, schema: { a: 1 } }, { name: 'shell_execute', on: false }],
      root: workspaceRoot,
    }),
    followInWindow: (event) => (event.type === 'reasoning-changed' ? reasoningSeen.push(event.chatId) : windowSeen.push(event)),
    log: { warn: () => {} },
  });
  return { adapter, runs, stops, heard, windowSeen, remembered, reasoningSeen };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a remote turn runs under a session of its own, in the open workspace, and ends with run-end', async () => {
  const { adapter, runs, heard } = writer({
    turn: ({ onEvent }) => {
      onEvent({ type: 'delta', payload: { text: 'Hi' } });
      onEvent({ type: 'secret', payload: { apiKey: 'x' } });
      return {};
    },
  });
  assert.deepEqual(await adapter.startTurn({ connectionId: 'conn-1', chatId: 'c1', text: 'Hello', runId: 'run-1' }), { ok: true });
  await settle();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].sessionId, 'remote:conn-1');
  assert.equal(runs[0].workspaceRoot, A, 'the open workspace, never one a request names');
  assert.deepEqual(runs[0].message, { content: 'Hello' });
  assert.deepEqual(heard, [
    { kind: 'run', chatId: 'c1', runId: 'run-1', type: 'delta', payload: { text: 'Hi' } },
    { kind: 'run', chatId: 'c1', runId: 'run-1', type: 'progress', payload: { type: 'run-end' } },
  ], 'only the turn\'s own events, and its end');
});

test('a turn that throws still ends with run-end', async () => {
  const { adapter, heard } = writer({ turn: async () => { throw new Error('lost'); } });
  await adapter.startTurn({ connectionId: 'conn-1', chatId: 'c1', text: 'Hello', runId: 'run-2' });
  await settle();
  await settle();
  assert.deepEqual(heard.map((e) => e.payload.type), ['run-end']);
});

test('no provider for the chat\'s model means unavailable, and nothing runs', async () => {
  const unknown = writer({ target: { error: { key: 'provider.error.unknown' }, code: 'INVALID' } });
  assert.deepEqual(await unknown.adapter.startTurn({ connectionId: 'c', chatId: 'c1', text: 'x', runId: 'r' }), { ok: false, reason: 'unavailable' });
  const noKey = writer({ invalid: { error: { key: 'provider.error.noKey' }, code: 'AUTH' } });
  assert.deepEqual(await noKey.adapter.startTurn({ connectionId: 'c', chatId: 'c1', text: 'x', runId: 'r' }), { ok: false, reason: 'unavailable' });
  assert.equal(unknown.runs.length + noKey.runs.length, 0);
});

test('stopChat and the configuration go through, the configuration without descriptions or schemas', async () => {
  const { adapter, stops } = writer();
  assert.equal(adapter.stopChat('running'), true);
  assert.equal(adapter.stopChat('idle'), false);
  assert.deepEqual(stops, ['running', 'idle']);
  assert.deepEqual(await adapter.chatConfiguration('c-ask', A), {
    model: { label: 'gpt-x' },
    mode: 'ask-all',
    reasoning: 'low',
    reasoningLevels: ['low', 'medium', 'high'],
    skills: [{ name: 'docs', state: 'on' }],
    tools: [{ name: 'read_file', on: true }, { name: 'shell_execute', on: false }],
  });
});

test('a model that takes no level reports neither a level nor levels (#1304)', async () => {
  const { adapter } = writer({ target: { providerId: 'p', model: 'plain' }, levels: [] });
  const configuration = await adapter.chatConfiguration('c1', A);
  assert.equal(configuration.reasoning, null);
  assert.deepEqual(configuration.reasoningLevels, []);
});

test('setReasoning keeps a level the model takes and tells the window, nothing else (#1304)', async () => {
  const { adapter, remembered, reasoningSeen } = writer();
  assert.deepEqual(await adapter.setReasoning('c1', 'high'), { ok: true, reasoning: 'high' });
  assert.deepEqual(await adapter.setReasoning('c1', 'max'), { ok: false, reason: 'invalid' });
  assert.deepEqual(remembered, [{ chatId: 'c1', level: 'high' }]);
  assert.deepEqual(reasoningSeen, ['c1']);
  const none = writer({ levels: [] });
  assert.deepEqual(await none.adapter.setReasoning('c1', 'low'), { ok: false, reason: 'invalid' });
  assert.equal(none.remembered.length, 0);
});

test('remote sessions are told apart from every window', () => {
  assert.equal(remoteSessionId('conn-9'), 'remote:conn-9');
  assert.equal(isRemoteSessionId('remote:conn-9'), true);
  assert.equal(isRemoteSessionId(3), false);
  assert.equal(isRemoteSessionId('conn-9'), false);
});

test('the window follows a remote turn from its saved question on, and hears its end (step 2b)', async () => {
  const { adapter, windowSeen } = writer({
    turn: ({ onEvent }) => {
      // Before the question is saved there is nothing in the chat to follow.
      onEvent({ type: 'progress', payload: { type: 'phase', phase: 'waiting' } });
      onEvent({ type: 'progress', payload: { type: 'chat-saved', ok: false, problem: 'failed' } });
      onEvent({ type: 'progress', payload: { type: 'chat-saved', ok: true, problem: null } });
      onEvent({ type: 'delta', payload: { text: 'Hi' } });
      onEvent({ type: 'progress', payload: { type: 'chat-saved', ok: true, problem: null } });
      return {};
    },
  });
  await adapter.startTurn({ connectionId: 'conn-1', chatId: 'c1', text: 'Hello', runId: 'run-1' });
  await settle();
  assert.deepEqual(windowSeen.map((e) => [e.type, e.payload.type || e.payload.text || e.payload.content]), [
    ['turn-started', 'Hello'],
    ['progress', 'chat-saved'],
    ['delta', 'Hi'],
    ['progress', 'chat-saved'],
    ['progress', 'run-end'],
  ]);
  for (const event of windowSeen) assert.equal(event.chatId, 'c1') ;
});

test('the question keeps where it came from, for the chat and for the window that follows it (#1197)', async () => {
  const { adapter, runs, windowSeen } = writer({
    turn: ({ onEvent }) => {
      onEvent({ type: 'progress', payload: { type: 'chat-saved', ok: true, problem: null } });
      return {};
    },
  });
  await adapter.startTurn({ connectionId: 'conn-1', chatId: 'c1', text: 'Hello', runId: 'run-1', origin: { kind: 'relay', client: ' iPhone\n' } });
  await settle();
  assert.deepEqual(runs[0].message, { content: 'Hello', origin: { kind: 'relay', client: 'iPhone' } });
  assert.deepEqual(windowSeen[0].payload, { content: 'Hello', origin: { kind: 'relay', client: 'iPhone' } });

  // A kind that leaves no mark sends the question as it is.
  await adapter.startTurn({ connectionId: 'conn-2', chatId: 'c2', text: 'Hi', runId: 'run-2', origin: { kind: 'local', client: 'cli' } });
  await settle();
  assert.deepEqual(runs[1].message, { content: 'Hi' });
});

test('a window that cannot follow does not hold up the turn', async () => {
  const activity = createRemoteActivity({ log: { warn: () => {} } });
  const warnings = [];
  const heard = [];
  activity.subscribe((event) => heard.push(event.type));
  const adapter = createRemoteDesktopAdapter({
    chatHistory: { listForRoots: async () => [], loadForDisplay: async () => null },
    workspaceFolderStore: { getValidatedFolderHistory: async () => [] },
    getActiveWorkspaceRoot: () => A,
    normalizeRoot,
    runningChatIds: () => [],
    listPendingApprovals: () => [],
    activity,
    conversation: {
      runTurn: async ({ onEvent }) => {
        onEvent({ type: 'progress', payload: { type: 'chat-saved', ok: true } });
        onEvent({ type: 'delta', payload: { text: 'on' } });
        return {};
      },
      stopChat: () => false,
    },
    llm: { resolveChatTarget: async () => ({ model: 'm' }), validateTarget: async () => null },
    followInWindow: () => { throw new Error('window gone'); },
    log: { warn: (line) => warnings.push(String(line)) },
  });
  await adapter.startTurn({ connectionId: 'c', chatId: 'c1', text: 'x', runId: 'r' });
  await settle();
  assert.deepEqual(heard, ['progress', 'delta', 'progress'], 'the remote still hears every event');
  assert.ok(warnings.length > 0 && warnings.every((w) => w === '[remote] the window could not follow a remote turn (Error)'));
});

test('a folder the phone asks for opens through the window, and the desktop is told (step 2c)', async () => {
  const activity = createRemoteActivity({ log: { warn: () => {} } });
  const asked = [];
  const told = [];
  const direct = [];
  let windowAnswer = 'switched';
  const adapter = createRemoteDesktopAdapter({
    chatHistory: { listForRoots: async () => [], loadForDisplay: async () => null },
    workspaceFolderStore: { getValidatedFolderHistory: async () => [] },
    getActiveWorkspaceRoot: () => A,
    normalizeRoot,
    runningChatIds: () => [],
    listPendingApprovals: () => [],
    activity,
    switchInWindow: async (root) => { asked.push(root); return windowAnswer; },
    activateKnownFolder: async (root) => { direct.push(root); return root === B ? B : null; },
    onSwitched: (root) => told.push(root),
  });
  assert.deepEqual(await adapter.activateWorkspace(B), { ok: true });
  windowAnswer = 'unsaved';
  assert.deepEqual(await adapter.activateWorkspace(B), { ok: false, reason: 'unsaved' });
  windowAnswer = 'no-answer';
  assert.deepEqual(await adapter.activateWorkspace(B), { ok: false, reason: 'no-answer' });
  assert.deepEqual(direct, [], 'with a window, main never switches underneath it');
  // No window: main opens a known folder itself.
  windowAnswer = 'no-window';
  assert.deepEqual(await adapter.activateWorkspace(B), { ok: true });
  assert.deepEqual(await adapter.activateWorkspace(path.resolve('/work/unknown')), { ok: false, reason: 'refused' });
  assert.deepEqual(told, [B, B], 'only a switch that happened is told');
});

test('cards reach the dispatcher as the activity of the desktop, and a phone\'s answer goes to the cards (step 3)', () => {
  const activity = createRemoteActivity({ log: { warn: () => {} } });
  const heard = [];
  const answers = [];
  activity.subscribe((event) => heard.push(event));
  const adapter = createRemoteDesktopAdapter({
    chatHistory: { listForRoots: async () => [], loadForDisplay: async () => null },
    workspaceFolderStore: { getValidatedFolderHistory: async () => [] },
    getActiveWorkspaceRoot: () => A,
    normalizeRoot,
    runningChatIds: () => [],
    listPendingApprovals: () => [{ requestId: 'r1', chatId: 'c1' }],
    respondToApproval: (requestId, answer, by) => { answers.push([requestId, answer, by]); return { ok: true, response: 'deny' }; },
    activity,
  });
  activity.publishApproval({ type: 'request', chatId: 'c1', dto: { requestId: 'r1' } });
  assert.deepEqual(heard, [{ kind: 'approval', type: 'request', chatId: 'c1', dto: { requestId: 'r1' } }]);
  assert.deepEqual(adapter.pendingApprovals(), [{ requestId: 'r1', chatId: 'c1' }]);
  assert.deepEqual(adapter.respondToApproval('r1', { response: 'deny' }, { kind: 'relay' }), { ok: true, response: 'deny' });
  assert.deepEqual(answers, [['r1', { response: 'deny' }, { kind: 'relay' }]]);
});
