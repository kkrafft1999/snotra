'use strict';

// The phone in the main window and staying awake for it (#1196): connected
// only with a session and a fresh heartbeat, held for a grace so a reconnect
// does not flicker, and the power-save port held only while connected and a
// run works.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRemotePresence, keepAwakeWanted, DISCONNECT_GRACE_MS } = require('../src/application/remote/remote-presence');

function harness({ failHold = false } = {}) {
  const timers = new Map();
  let nextTimer = 0;
  const held = new Set();
  let handles = 0;
  const warnings = [];
  const states = [];
  const presence = createRemotePresence({
    powerSave: {
      hold: () => {
        if (failHold) throw new Error('refused');
        held.add(++handles);
        return handles;
      },
      release: (handle) => held.delete(handle),
    },
    setTimer: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimer: (id) => timers.delete(id),
    log: { warn: (line) => warnings.push(line) },
  });
  presence.subscribe((state) => states.push(state));
  const fire = () => {
    const pending = [...timers.entries()];
    timers.clear();
    for (const [, { fn }] of pending) fn();
  };
  return { presence, timers, held, warnings, states, fire };
}

test('the rule: awake only while connected and a run works', () => {
  assert.equal(keepAwakeWanted({ connected: true, working: true }), true);
  assert.equal(keepAwakeWanted({ connected: true, working: false }), false);
  assert.equal(keepAwakeWanted({ connected: false, working: true }), false);
  assert.equal(keepAwakeWanted({ connected: false, working: false }), false);
});

test('a run alone keeps nothing awake; a phone that connects to it does, and either ending lets go', () => {
  const { presence, held, states } = harness();
  presence.setWorking(true);
  assert.equal(held.size, 0);
  assert.deepEqual(states, [], 'nothing changed for the window');

  presence.setConnected(true);
  assert.equal(held.size, 1);
  assert.deepEqual(presence.getState(), { connected: true, keepingAwake: true });

  presence.setWorking(false);
  assert.equal(held.size, 0, 'the run ended');
  assert.deepEqual(presence.getState(), { connected: true, keepingAwake: false });

  presence.setWorking(true);
  presence.setWorking(true);
  assert.equal(held.size, 1, 'held once, however often it is said');
  assert.deepEqual(states, [
    { connected: true, keepingAwake: true },
    { connected: true, keepingAwake: false },
    { connected: true, keepingAwake: true },
  ]);
});

test('working while the chat engine counts any running chat', () => {
  const { presence, held } = harness();
  presence.setConnected(true);
  presence.setRunningChats(new Set(['chat-a']));
  assert.equal(held.size, 1);
  presence.setRunningChats(new Set());
  assert.equal(held.size, 0);
});

test('a phone that comes back within the grace does not flicker; one that does not is gone after it', () => {
  const { presence, timers, held, states, fire } = harness();
  presence.setWorking(true);
  presence.setConnected(true);
  presence.setConnected(false);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, DISCONNECT_GRACE_MS);
  assert.deepEqual(presence.getState(), { connected: true, keepingAwake: true }, 'still shown, still awake');

  presence.setConnected(true);
  assert.equal(timers.size, 0, 'back in time: the grace is called off');
  assert.equal(states.length, 1, 'the window saw no change');

  presence.setConnected(false);
  fire();
  assert.deepEqual(presence.getState(), { connected: false, keepingAwake: false });
  assert.equal(held.size, 0);
  assert.deepEqual(states.at(-1), { connected: false, keepingAwake: false });
});

test('a removed phone ends at once, without the grace', () => {
  const { presence, timers, held } = harness();
  presence.setWorking(true);
  presence.setConnected(true);
  presence.setConnected(false);
  presence.end();
  assert.equal(timers.size, 0);
  assert.equal(held.size, 0);
  assert.deepEqual(presence.getState(), { connected: false, keepingAwake: false });
});

test('a power-save port that refuses is logged, and the window is not told it is kept awake', () => {
  const { presence, warnings } = harness({ failHold: true });
  presence.setConnected(true);
  presence.setWorking(true);
  assert.deepEqual(presence.getState(), { connected: true, keepingAwake: false });
  assert.match(warnings.join('\n'), /keeping the computer awake failed/);
});

test('without a power-save port it still says connected, and never awake', () => {
  const presence = createRemotePresence({ log: { warn: () => {} } });
  presence.setConnected(true);
  presence.setWorking(true);
  assert.deepEqual(presence.getState(), { connected: true, keepingAwake: false });
  presence.dispose();
});

test('dispose lets the computer sleep and stops the grace', () => {
  const { presence, timers, held, states } = harness();
  presence.setWorking(true);
  presence.setConnected(true);
  presence.setConnected(false);
  presence.dispose();
  assert.equal(held.size, 0);
  assert.equal(timers.size, 0);
  const before = states.length;
  presence.setConnected(true);
  assert.equal(states.length, before, 'nothing after dispose');
});
