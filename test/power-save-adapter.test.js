'use strict';

// Electron's powerSaveBlocker as the power-save port (#1196).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPowerSaveAdapter } = require('../src/main/electron/power-save-adapter');

test('holds with prevent-app-suspension and stops only a blocker that still runs', () => {
  const started = new Set();
  const calls = [];
  const adapter = createPowerSaveAdapter({
    powerSaveBlocker: {
      start: (type) => { calls.push(['start', type]); started.add(7); return 7; },
      stop: (id) => { calls.push(['stop', id]); started.delete(id); },
      isStarted: (id) => started.has(id),
    },
  });
  const handle = adapter.hold();
  adapter.release(handle);
  adapter.release(handle);
  adapter.release('not a handle');
  assert.deepEqual(calls, [['start', 'prevent-app-suspension'], ['stop', 7]]);
});

test('without Electron\'s blocker there is no port', () => {
  assert.equal(createPowerSaveAdapter({ powerSaveBlocker: null }), null);
});
