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
