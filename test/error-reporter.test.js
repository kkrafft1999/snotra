const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  createErrorReporter,
  installProcessErrorHandlers,
  normalizeRendererReport,
} = require('../src/main/services/error-reporter');
const { createAppNotices } = require('../src/main/services/app-notices');
const { NOTICE_KINDS, BACKGROUND_ERROR_NOTICE_ID } = require('../src/shared/contracts/notices');

/** One path for errors nobody caught (#978): logged, counted, one notice. */

function harness({ coalesceMs = 1000, maxCoalesceMs = 60_000, maxLogged = 100 } = {}) {
  let clock = 0;
  const timers = [];
  const logged = [];
  const notices = createAppNotices({ log: { warn() {} } });
  const posted = [];
  notices.subscribe((event) => { if (event.type === 'posted') posted.push(event.notice); });
  const reporter = createErrorReporter({
    log: { error: (...args) => logged.push(args) },
    notices,
    logFilePath: '/profile/logs/main.log',
    coalesceMs,
    maxCoalesceMs,
    maxLogged,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms };
      timers.push(timer);
      return timer;
    },
  });
  /** Moves the clock and fires what is due. */
  function advance(ms) {
    clock += ms;
    for (const timer of timers.splice(0)) {
      if (timer.at <= clock) timer.fn();
      else timers.push(timer);
    }
  }
  return { reporter, logged, posted, notices, advance, timers };
}

test('the first error is logged with its label and posts the notice at once', () => {
  const { reporter, logged, posted } = harness();
  const error = new Error('boom');
  reporter.report('main', 'Uncaught exception', error);
  assert.deepEqual(logged, [['[main] Uncaught exception:', error]]);
  assert.deepEqual(posted, [{
    id: BACKGROUND_ERROR_NOTICE_ID,
    kind: NOTICE_KINDS.BACKGROUND_ERROR,
    count: 1,
    location: '/profile/logs/main.log',
    canReveal: true,
  }]);
  assert.equal(reporter.count(), 1);
});

test('errors in quick succession go out as one post with the count, and the wait backs off', () => {
  const { reporter, posted, advance } = harness({ coalesceMs: 1000 });
  reporter.report('main', 'x', new Error('1'));
  reporter.report('main', 'x', new Error('2'));
  reporter.report('renderer', 'x', new Error('3'));
  assert.equal(posted.length, 1);
  advance(999);
  assert.equal(posted.length, 1);
  advance(1);
  assert.deepEqual(posted.map((n) => n.count), [1, 3]);

  // The next wait is twice as long.
  reporter.report('main', 'x', new Error('4'));
  advance(1999);
  assert.equal(posted.length, 2);
  advance(1);
  assert.deepEqual(posted.map((n) => n.count), [1, 3, 4]);
});

test('the back-off stops at its ceiling', () => {
  const { reporter, posted, advance } = harness({ coalesceMs: 1000, maxCoalesceMs: 3000 });
  for (let i = 0; i < 6; i += 1) {
    reporter.report('main', 'x', new Error(String(i)));
    advance(3000);
  }
  assert.equal(posted.length, 6, 'once the ceiling is reached, one post per 3 s');
});

test('a notice the user closed comes back with the next error', () => {
  const { reporter, notices, advance } = harness();
  reporter.report('main', 'x', new Error('1'));
  notices.dismiss(BACKGROUND_ERROR_NOTICE_ID);
  assert.deepEqual(notices.list(), []);
  advance(5000);
  reporter.report('main', 'x', new Error('2'));
  assert.equal(notices.list()[0].count, 2);
});

test('after maxLogged errors only the count goes up, with one line that says so', () => {
  const { reporter, logged } = harness({ maxLogged: 2 });
  for (let i = 0; i < 5; i += 1) reporter.report('main', 'x', new Error(String(i)));
  assert.equal(logged.length, 3);
  assert.match(logged[2][0], /More than 2 errors/);
  assert.equal(reporter.count(), 5);
});

test('a log or a notice list that throws does not escape the reporter', () => {
  const reporter = createErrorReporter({
    log: { error() { throw new Error('log down'); } },
    notices: { post() { throw new Error('notices down'); } },
  });
  assert.doesNotThrow(() => reporter.report('main', 'x', new Error('boom')));
  assert.equal(reporter.count(), 1);
});

test('a report from the window is logged with its stack and where it was thrown', () => {
  const { reporter, logged, posted } = harness();
  assert.equal(reporter.reportRenderer({
    source: 'rejection',
    message: 'fetch failed',
    stack: 'TypeError: fetch failed\n    at load (components/ChatStream.js:10:5)',
    at: '',
  }), true);
  assert.equal(logged[0][0], '[renderer] Unhandled promise rejection:');
  assert.equal(logged[0][1], 'TypeError: fetch failed\n    at load (components/ChatStream.js:10:5)');
  reporter.reportRenderer({ source: 'error', message: 'x is not defined', stack: '', at: 'app.js:12' });
  assert.equal(logged[1][0], '[renderer] Uncaught error:');
  assert.equal(logged[1][1], 'x is not defined (app.js:12)');
  assert.equal(posted[0].count, 1);
});

test('a broken report from the window is refused without counting', () => {
  const { reporter } = harness();
  assert.equal(reporter.reportRenderer(null), false);
  assert.equal(reporter.reportRenderer({ source: 'error', message: 42 }), false);
  assert.equal(reporter.count(), 0);
});

test('the window report is trimmed and its source is one of two', () => {
  const entry = normalizeRendererReport({ source: 'anything', message: 'm'.repeat(5000), stack: 7, at: 'a.js:1' });
  assert.equal(entry.source, 'error');
  assert.equal(entry.message.length, 4000);
  assert.equal(entry.stack, '');
  assert.equal(entry.at, 'a.js:1');
});

test('main\'s process handlers report exceptions and rejections, and can be removed', () => {
  const proc = new EventEmitter();
  const seen = [];
  const remove = installProcessErrorHandlers(proc, { report: (...args) => seen.push(args) });
  const error = new Error('thrown');
  proc.emit('uncaughtException', error);
  proc.emit('unhandledRejection', 'just a string');
  assert.deepEqual(seen, [
    ['main', 'Uncaught exception', error],
    ['main', 'Unhandled promise rejection', 'just a string'],
  ]);
  remove();
  assert.equal(proc.listenerCount('uncaughtException'), 0);
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
});
