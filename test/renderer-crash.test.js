const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererCrashHandler } = require('../src/main/services/renderer-crash');

/** A page that dies leaves a box with a reload offer, not a blank window (#978). */

function harness({ response = 0, locale = 'en', destroyed = false } = {}) {
  const calls = [];
  let resolveBox = null;
  const window = {
    isDestroyed: () => destroyed,
    webContents: { reload: () => calls.push('reload') },
  };
  const dialog = {
    showMessageBox: (win, options) => {
      calls.push(['box', options]);
      assert.equal(win, window, 'the box belongs to the window');
      return new Promise((resolve) => { resolveBox = () => resolve({ response }); });
    },
  };
  const handler = createRendererCrashHandler({
    dialog,
    window,
    app: { quit: () => calls.push('quit') },
    appName: 'Snotra Agent',
    getLocale: () => locale,
    log: { error: (...args) => calls.push(['log', ...args]) },
  });
  return { handler, calls, answer: () => resolveBox?.() };
}

test('a crash is logged and offers a reload, which reloads the window', async () => {
  const { handler, calls, answer } = harness({ response: 0 });
  const done = handler({}, { reason: 'crashed', exitCode: 11 });
  answer();
  await done;
  assert.match(calls[0][1], /reason: crashed, exit code: 11/);
  const box = calls[1][1];
  assert.equal(box.type, 'error');
  assert.equal(box.message, 'The window stopped working');
  assert.match(box.detail, /reason: crashed/);
  assert.deepEqual(box.buttons, ['Reload Window', 'Quit Snotra Agent']);
  assert.equal(box.defaultId, 0);
  assert.equal(calls.at(-1), 'reload');
});

test('the second button quits the app', async () => {
  const { handler, calls, answer } = harness({ response: 1 });
  const done = handler({}, { reason: 'oom' });
  answer();
  await done;
  assert.equal(calls.at(-1), 'quit');
});

test('the box speaks the interface language', async () => {
  const { handler, calls, answer } = harness({ locale: 'de' });
  const done = handler({}, { reason: 'killed' });
  answer();
  await done;
  const box = calls[1][1];
  assert.equal(box.message, 'Das Fenster funktioniert nicht mehr');
  assert.deepEqual(box.buttons, ['Fenster neu laden', 'Snotra Agent beenden']);
});

test('a page that ended because the window closed says nothing', async () => {
  const { handler, calls } = harness();
  await handler({}, { reason: 'clean-exit' });
  assert.deepEqual(calls, []);
});

test('a second crash while the box is open does not open a second box', async () => {
  const { handler, calls, answer } = harness();
  const first = handler({}, { reason: 'crashed' });
  await handler({}, { reason: 'crashed' });
  answer();
  await first;
  assert.equal(calls.filter((c) => Array.isArray(c) && c[0] === 'box').length, 1);
  assert.equal(calls.filter((c) => Array.isArray(c) && c[0] === 'log').length, 2, 'both are logged');
});

test('a window that is already gone gets no box', async () => {
  const { handler, calls } = harness({ destroyed: true });
  await handler({}, { reason: 'crashed' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'log');
});
