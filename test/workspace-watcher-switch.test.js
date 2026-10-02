// A folder switch drops what the watcher had not reported yet (#650).
//
// Before, an event of the folder just left could sit in the debounce window
// across the switch and come out afterwards, naming a folder of the old root.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path').posix;

const { createWorkspaceWatcher } = require('../src/main/services/workspace-watcher');

const A = path.join(path.sep, 'projects', 'a');
const B = path.join(path.sep, 'projects', 'b');

function setup() {
  const created = [];
  const watch = (dir, options, handler) => {
    const watcher = {
      dir,
      handler,
      closed: false,
      on() {
        return this;
      },
      close() {
        this.closed = true;
      },
    };
    created.push(watcher);
    return watcher;
  };
  let timers = [];
  let nextId = 0;
  const clock = {
    setTimeoutImpl: (fn) => {
      const timer = { fn, id: (nextId += 1) };
      timers.push(timer);
      return timer.id;
    },
    clearTimeoutImpl: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
    nowImpl: () => 0,
    /** Runs every timer that is set, until none is left. */
    runAll() {
      while (timers.length > 0) timers.shift().fn();
    },
  };
  const reports = [];
  const watcher = createWorkspaceWatcher({
    watch,
    path,
    platform: 'darwin',
    onChange: (payload) => reports.push(payload),
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    nowImpl: clock.nowImpl,
    startRecheckMs: 0,
  });
  const fireAt = (root, relativePath) =>
    created.filter((w) => w.dir === root && !w.closed).at(-1).handler('rename', relativePath);
  return { watcher, clock, reports, fireAt };
}

test('a report still pending for the old folder does not arrive after the switch (#650)', () => {
  const { watcher, clock, reports, fireAt } = setup();
  watcher.watchWorkspace(A);
  fireAt(A, path.join('only-in-a', 'x.txt'));
  // The event is in, the report still waits out the debounce — and the user
  // opens another folder.
  watcher.watchWorkspace(B);
  clock.runAll();

  assert.deepEqual(reports, [], 'nothing names a folder of the old root');

  fireAt(B, path.join('docs', 'y.md'));
  clock.runAll();
  assert.deepEqual(reports, [{ directories: [path.join(B, 'docs')], complete: true }]);
  watcher.close();
});

test('a switch to no folder drops the pending report as well (#650)', () => {
  const { watcher, clock, reports, fireAt } = setup();
  watcher.watchWorkspace(A);
  fireAt(A, 'x.txt');
  watcher.watchWorkspace(null);
  clock.runAll();
  assert.deepEqual(reports, []);
  watcher.close();
});

test('the same folder set again keeps what is pending (#650)', () => {
  const { watcher, clock, reports, fireAt } = setup();
  watcher.watchWorkspace(A);
  fireAt(A, path.join('docs', 'x.md'));
  // Not a switch: the pending report is still about the folder that is open.
  watcher.watchWorkspace(A);
  clock.runAll();
  assert.deepEqual(reports, [{ directories: [path.join(A, 'docs')], complete: true }]);
  watcher.close();
});
