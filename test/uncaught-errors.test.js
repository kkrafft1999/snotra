const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

/** The window's global error handlers (#978): what nobody caught goes to main. */

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'utils', 'uncaught-errors.js')).href);

function errorEvent(error, extra = {}) {
  const event = new Event('error');
  Object.assign(event, { error, message: error?.message ?? '', ...extra });
  return event;
}

function rejectionEvent(reason) {
  const event = new Event('unhandledrejection');
  event.reason = reason;
  return event;
}

test('an uncaught error is described with message, stack and place', async () => {
  const { describeUncaughtEvent } = await load();
  const error = new TypeError('x is not a function');
  error.stack = 'TypeError: x is not a function\n    at send (ChatStream.js:5:1)';
  assert.deepEqual(describeUncaughtEvent(errorEvent(error, { filename: 'app://ChatStream.js', lineno: 5 })), {
    source: 'error',
    message: 'x is not a function',
    stack: error.stack,
    at: 'app://ChatStream.js:5',
  });
});

test('a rejection with no Error still says what it was', async () => {
  const { describeUncaughtEvent } = await load();
  assert.deepEqual(describeUncaughtEvent(rejectionEvent('timeout')), {
    source: 'rejection', message: 'timeout', stack: '', at: '',
  });
  assert.equal(describeUncaughtEvent(rejectionEvent(undefined)).message, 'unknown reason');
  assert.equal(describeUncaughtEvent(errorEvent(undefined, { message: 'Script error.' })).message, 'Script error.');
});

test('the ResizeObserver note is not an error and is not reported', async () => {
  const { describeUncaughtEvent } = await load();
  assert.equal(describeUncaughtEvent(errorEvent(undefined, {
    message: 'ResizeObserver loop completed with undelivered notifications.',
  })), null);
  assert.equal(describeUncaughtEvent(errorEvent(undefined, { message: 'ResizeObserver loop limit exceeded' })), null);
});

test('the reporter listens to both events, stops at its cap, and can be removed', async () => {
  const { reportUncaughtErrors } = await load();
  const target = new EventTarget();
  const reports = [];
  const stop = reportUncaughtErrors(target, (entry) => reports.push(entry), { maxReports: 3 });
  target.dispatchEvent(errorEvent(new Error('one')));
  target.dispatchEvent(rejectionEvent(new Error('two')));
  target.dispatchEvent(errorEvent(undefined, { message: 'ResizeObserver loop limit exceeded' }));
  target.dispatchEvent(errorEvent(new Error('three')));
  target.dispatchEvent(errorEvent(new Error('four')));
  assert.deepEqual(reports.map((r) => [r.source, r.message]), [['error', 'one'], ['rejection', 'two'], ['error', 'three']]);
  stop();
  const after = [];
  reportUncaughtErrors(target, () => {}); // a fresh one does not see the old reports
  target.dispatchEvent(errorEvent(new Error('five')));
  assert.equal(reports.length, 3);
  assert.deepEqual(after, []);
});

test('a report that fails or throws does not escape the handler', async () => {
  const { reportUncaughtErrors } = await load();
  const target = new EventTarget();
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    reportUncaughtErrors(target, () => Promise.reject(new Error('ipc down')));
    reportUncaughtErrors(target, () => { throw new Error('sync'); });
    assert.doesNotThrow(() => target.dispatchEvent(errorEvent(new Error('x'))));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
