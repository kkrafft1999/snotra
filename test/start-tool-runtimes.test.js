const test = require('node:test');
const assert = require('node:assert/strict');
const { startToolRuntimes } = require('../src/main/composition/start-tool-runtimes');

function recordingLog() {
  const errors = [];
  return { errors, error: (...args) => errors.push(args) };
}

test('a refresh that throws skips neither the other runtimes nor the notification (#1002)', async () => {
  const started = [];
  const log = recordingLog();
  let notified = 0;
  const result = await startToolRuntimes({
    runtimes: [
      { name: 'python', start: async () => { started.push('python'); throw new Error('detect broke'); } },
      { name: 'shell', start: async () => { started.push('shell'); } },
      // A synchronous throw counts as a failure of its own, not of the call.
      { name: 'web search', start: () => { throw new Error('store broke'); } },
      { name: 'MCP', start: async () => { started.push('MCP'); } },
    ],
    onSettled: () => { notified += 1; },
    log,
  });

  assert.deepEqual(started, ['python', 'shell', 'MCP']);
  assert.equal(notified, 1);
  assert.deepEqual(result, { failed: ['python', 'web search'] });
  // The failure is not swallowed: each one is logged with its runtime's name.
  assert.equal(log.errors.length, 2);
  assert.match(log.errors[0][0], /python/);
  assert.equal(log.errors[0][1].message, 'detect broke');
  assert.match(log.errors[1][0], /web search/);
});

test('without a failure nothing is logged and the notification still comes once', async () => {
  const log = recordingLog();
  let notified = 0;
  const result = await startToolRuntimes({
    runtimes: [{ name: 'python', start: async () => 'ok' }],
    onSettled: () => { notified += 1; },
    log,
  });
  assert.deepEqual(result, { failed: [] });
  assert.equal(notified, 1);
  assert.deepEqual(log.errors, []);
});

test('a notification that throws does not reject the start-up', async () => {
  const log = recordingLog();
  const result = await startToolRuntimes({
    runtimes: [],
    onSettled: () => { throw new Error('window gone'); },
    log,
  });
  assert.deepEqual(result, { failed: [] });
  assert.equal(log.errors.length, 1);
});
