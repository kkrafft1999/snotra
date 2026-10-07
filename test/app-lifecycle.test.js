'use strict';

// Single instance (#507) and a failed start-up (#509), with an injected `app`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { claimSingleInstance, createStartupFailureHandler, holdQuitForPendingWrites } = require('../src/main/app-lifecycle');

function makeApp({ locked = true, locale = 'en-US' } = {}) {
  const listeners = new Map();
  const calls = [];
  return {
    calls,
    emit: (event, ...args) => listeners.get(event)?.(...args),
    requestSingleInstanceLock: () => { calls.push('lock'); return locked; },
    quit: () => calls.push('quit'),
    exit: (code) => calls.push(['exit', code]),
    getLocale: () => locale,
    on: (event, listener) => listeners.set(event, listener),
    has: (event) => listeners.has(event),
  };
}

function makeWindow({ minimized = false, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus'),
  };
}

test('without the lock the process quits and starts nothing', () => {
  const app = makeApp({ locked: false });
  let created = 0;
  const primary = claimSingleInstance({ app, getMainWindow: () => null, createWindow: () => { created += 1; } });
  assert.equal(primary, false);
  assert.deepEqual(app.calls, ['lock', 'quit']);
  assert.equal(app.has('second-instance'), false);
  assert.equal(created, 0);
});

test('with the lock the process runs and listens for a second launch', () => {
  const app = makeApp();
  assert.equal(claimSingleInstance({ app, getMainWindow: () => null, createWindow: () => {} }), true);
  assert.deepEqual(app.calls, ['lock']);
  assert.equal(app.has('second-instance'), true);
});

test('a second launch restores and focuses a minimised main window', () => {
  const app = makeApp();
  const win = makeWindow({ minimized: true });
  let created = 0;
  claimSingleInstance({ app, getMainWindow: () => win, createWindow: () => { created += 1; } });
  app.emit('second-instance');
  assert.deepEqual(win.calls, ['restore', 'focus']);
  assert.equal(created, 0);
});

test('a second launch focuses a window that is not minimised without restoring it', () => {
  const app = makeApp();
  const win = makeWindow();
  claimSingleInstance({ app, getMainWindow: () => win, createWindow: () => {} });
  app.emit('second-instance');
  assert.deepEqual(win.calls, ['focus']);
});

test('a second launch creates the window when there is none (macOS without a window)', () => {
  const app = makeApp();
  let created = 0;
  claimSingleInstance({ app, getMainWindow: () => makeWindow({ destroyed: true }), createWindow: () => { created += 1; } });
  app.emit('second-instance');
  assert.equal(created, 1);
});

test('before the application is built a second launch creates no window of its own', () => {
  const app = makeApp();
  let created = 0;
  claimSingleInstance({
    app,
    getMainWindow: () => null,
    createWindow: () => { created += 1; },
    canCreateWindow: () => false,
  });
  app.emit('second-instance');
  assert.equal(created, 0);
});

test('a failed start-up is logged, shown in the system language and ends the app', () => {
  const app = makeApp({ locale: 'de-DE' });
  const boxes = [];
  const logged = [];
  const fail = createStartupFailureHandler({
    app,
    dialog: { showErrorBox: (title, body) => boxes.push({ title, body }) },
    log: { error: (...args) => logged.push(args) },
    appName: 'Snotra Agent',
  });
  const error = new Error('store unreadable');
  fail(error);

  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], error);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].title, 'Snotra Agent konnte nicht starten');
  assert.match(boxes[0].body, /store unreadable/);
  assert.doesNotMatch(boxes[0].body, /at .*\.js/, 'the stack stays in the log');
  assert.deepEqual(app.calls, [['exit', 1]]);
});

test('the app ends even when the error box cannot be shown', () => {
  const app = makeApp();
  const fail = createStartupFailureHandler({
    app,
    dialog: { showErrorBox: () => { throw new Error('no display'); } },
    log: { error: () => {} },
  });
  fail('plain string');
  assert.deepEqual(app.calls, [['exit', 1]]);
});

test('an English or unknown system language gets the English box', () => {
  const app = makeApp({ locale: 'fr-FR' });
  const boxes = [];
  createStartupFailureHandler({
    app,
    dialog: { showErrorBox: (title) => boxes.push(title) },
    log: { error: () => {} },
  })(new Error('x'));
  assert.deepEqual(boxes, ['Snotra Agent could not start']);
});

function quitEvent() {
  const event = { prevented: false, preventDefault: () => { event.prevented = true; } };
  return event;
}

test('a quit waits for the stores, then quits again — and that one goes through (#679)', async () => {
  const app = makeApp();
  let finish;
  holdQuitForPendingWrites({ app, whenWritesSettled: () => new Promise((resolve) => { finish = resolve; }) });
  const first = quitEvent();
  app.emit('before-quit', first);
  assert.equal(first.prevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.calls, [], 'no quit while a write is under way');
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.calls, ['quit']);
  const second = quitEvent();
  app.emit('before-quit', second);
  assert.equal(second.prevented, false);
});

test('a write that hangs holds the quit only for the grace period (#679)', async () => {
  const app = makeApp();
  const warnings = [];
  holdQuitForPendingWrites({
    app, whenWritesSettled: () => new Promise(() => {}), graceMs: 10, log: { warn: (m) => warnings.push(m) },
  });
  app.emit('before-quit', quitEvent());
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(app.calls, ['quit']);
  assert.equal(warnings.length, 1);
});

test('a failing store does not keep the app from quitting (#679)', async () => {
  const app = makeApp();
  holdQuitForPendingWrites({ app, whenWritesSettled: () => Promise.reject(new Error('disk')), graceMs: 1000 });
  app.emit('before-quit', quitEvent());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.calls, ['quit']);
});
