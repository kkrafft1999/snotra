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

function writer({ target = { providerId: 'p', model: 'gpt-x' }, invalid = null, turn } = {}) {
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
    },
    chatMode: async (chatId) => (chatId === 'c-ask' ? 'ask-all' : 'smart'),
    reasoningFor: async () => 'low',
    describeConfiguration: async ({ workspaceRoot }) => ({
      skills: [{ name: 'docs', state: 'on', description: 'secret text' }, { nope: true }],
      tools: [{ name: 'read_file', on: true, schema: { a: 1 } }, { name: 'shell_execute', on: false }],
      root: workspaceRoot,
    }),
    log: { warn: () => {} },
  });
  return { adapter, runs, stops, heard };
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
    skills: [{ name: 'docs', state: 'on' }],
    tools: [{ name: 'read_file', on: true }, { name: 'shell_execute', on: false }],
  });
});

test('remote sessions are told apart from every window', () => {
  assert.equal(remoteSessionId('conn-9'), 'remote:conn-9');
  assert.equal(isRemoteSessionId('remote:conn-9'), true);
  assert.equal(isRemoteSessionId(3), false);
  assert.equal(isRemoteSessionId('conn-9'), false);
});
