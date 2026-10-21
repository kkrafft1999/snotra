'use strict';

// The phone opens another folder through the window (#1194, step 2c): main
// asks the window and waits for its answer, a bounded time.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWindowWorkspaceSwitch } = require('../src/main/remote/window-workspace-switch');
const { PUSH_CHANNELS: PUSH, REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');

function setup({ window = true } = {}) {
  const sent = [];
  const timers = [];
  let ids = 0;
  const windowSwitch = createWindowWorkspaceSwitch({
    push: (channel, payload) => { if (window) sent.push([channel, payload]); return window; },
    PUSH,
    randomUUID: () => `req-${(ids += 1)}`,
    timeoutMs: 1000,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  return { windowSwitch, sent, timers };
}

test('the window is asked by request id and its answer settles the switch', async () => {
  const { windowSwitch, sent, timers } = setup();
  const pending = windowSwitch.switchTo('/work/b');
  assert.deepEqual(sent, [[PUSH.WORKSPACE_SWITCH_REQUESTED, { requestId: 'req-1', folderPath: '/work/b' }]]);
  windowSwitch.answer({ requestId: 'other', outcome: 'switched' });
  windowSwitch.answer({ requestId: 'req-1', outcome: 'unsaved' });
  assert.equal(await pending, 'unsaved');
  assert.equal(timers[0].cleared, true);
  // A late or repeated answer changes nothing.
  windowSwitch.answer({ requestId: 'req-1', outcome: 'switched' });
  assert.equal(REQ.WORKSPACE_SWITCH_ANSWER, 'workspace:switch-answer');
});

test('an answer the window cannot give is refused, no answer in time is no-answer', async () => {
  const { windowSwitch, timers } = setup();
  const odd = windowSwitch.switchTo('/work/b');
  windowSwitch.answer({ requestId: 'req-1', outcome: 'deleted-everything' });
  assert.equal(await odd, 'refused');
  const silent = windowSwitch.switchTo('/work/c');
  timers[1].fn();
  assert.equal(await silent, 'no-answer');
  windowSwitch.answer(null);
});

test('without a window there is nobody to ask', async () => {
  const { windowSwitch } = setup({ window: false });
  assert.equal(await windowSwitch.switchTo('/work/b'), 'no-window');
});
