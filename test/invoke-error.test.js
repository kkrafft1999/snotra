// A rejected invoke, put into the user's words (#1013).

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer } = require('./helpers/dom.js');

test('the detail drops Electron\'s wrapper and keeps main\'s own text', async () => {
  const { invokeErrorDetail } = await importRenderer('utils', 'invoke-error.js');
  const wrapped = new Error("Error invoking remote method 'update:download': Error: socket hang up");
  assert.equal(invokeErrorDetail(wrapped), 'socket hang up');
  const typed = new Error("Error invoking remote method 'settings:get': TypeError: x is not a function");
  assert.equal(invokeErrorDetail(typed), 'x is not a function');
  // Not from an invoke: left as it is, an "Error:" in the text included.
  assert.equal(invokeErrorDetail(new Error('Error: kept')), 'Error: kept');
  assert.equal(invokeErrorDetail('plain'), 'plain');
  assert.equal(invokeErrorDetail(undefined), '');
  assert.equal(invokeErrorDetail({}), '');
});

test('the message is the caller\'s key, and the raw text goes to the console only', async (t) => {
  const { invokeErrorMessage } = await importRenderer('utils', 'invoke-error.js');
  const warned = [];
  t.mock.method(console, 'warn', (...args) => warned.push(args.join(' ')));
  const err = new Error("Error invoking remote method 'voice:start': Error: no key");

  assert.deepEqual(invokeErrorMessage(err, 'chat.voice.failed'), { key: 'chat.voice.failed' });
  assert.deepEqual(invokeErrorMessage(err, 'settings.loadFailed', { error: 'x' }), {
    key: 'settings.loadFailed',
    params: { error: 'x' },
  });
  assert.equal(warned.length, 2);
  assert.match(warned[0], /chat\.voice\.failed.*no key/);
});
