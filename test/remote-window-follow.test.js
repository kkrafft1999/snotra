'use strict';

// A phone's turn reaches the window on the channels of its own turns (#1194,
// step 2b), the route last so that a payload cannot name another chat.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWindowFollower } = require('../src/main/remote/window-follow');
const { PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');

test('each event goes on its channel, with its chat and run', () => {
  const sent = [];
  const follow = createWindowFollower({ push: (channel, payload) => { sent.push([channel, payload]); return true; }, PUSH });
  follow({ chatId: 'c1', runId: 'r1', type: 'turn-started', payload: { content: 'Hello' } });
  follow({ chatId: 'c1', runId: 'r1', type: 'delta', payload: { text: 'Hi', chatId: 'other', runId: 'forged' } });
  follow({ chatId: 'c1', runId: 'r1', type: 'tool-line', payload: { line: 'Read a.md', phase: 'done' } });
  follow({ chatId: 'c1', runId: 'r1', type: 'progress', payload: { type: 'run-end' } });
  follow({ chatId: 'c1', runId: 'r1', type: 'toString', payload: {} });
  assert.deepEqual(sent, [
    [PUSH.CHAT_TURN_STARTED, { content: 'Hello', chatId: 'c1', runId: 'r1' }],
    [PUSH.CHAT_DELTA, { text: 'Hi', chatId: 'c1', runId: 'r1' }],
    [PUSH.CHAT_TOOL_LINE, { line: 'Read a.md', phase: 'done', chatId: 'c1', runId: 'r1' }],
    [PUSH.CHAT_PROGRESS, { type: 'run-end', chatId: 'c1', runId: 'r1' }],
  ]);
  assert.equal(PUSH.CHAT_TURN_STARTED, 'chat:turn-started');
});

test('a reasoning level a phone set reaches the window without a run (#1304)', () => {
  const sent = [];
  const follow = createWindowFollower({ push: (channel, payload) => { sent.push([channel, payload]); return true; }, PUSH });
  follow({ chatId: 'c1', runId: null, type: 'reasoning-changed', payload: {} });
  assert.deepEqual(sent, [[PUSH.CHAT_REASONING_CHANGED, { chatId: 'c1', runId: null }]]);
});
