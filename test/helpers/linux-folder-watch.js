'use strict';

/**
 * Stand-ins for driving the folder-by-folder watch Linux gets (#648) on every
 * OS: an in-memory tree, a fake `fs.watch` and a clock the test drives. Shared
 * by the tests of that watch, so each file can stay with what it tests.
 */

const assert = require('node:assert/strict');
const path = require('path').posix;

const { createWorkspaceWatcher } = require('../../src/main/services/workspace-watcher');

const WS = path.join(path.sep, 'projects', 'demo');

const abs = (...segments) => path.join(WS, ...segments);

/** An in-memory tree: absolute path → 'dir' | 'file' | 'symlink'. */
function createMemoryFs(entries = {}) {
  const nodes = new Map([[WS, 'dir']]);
  /** Every path `lstat` was asked about, in order. */
  const lstatCalls = [];
  const add = (relPath, kind) => {
    const segments = relPath.split('/');
    for (let i = 1; i < segments.length; i += 1) nodes.set(path.join(WS, ...segments.slice(0, i)), 'dir');
    nodes.set(path.join(WS, relPath), kind);
  };
  for (const [relPath, kind] of Object.entries(entries)) add(relPath, kind);
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    nodes,
    add,
    lstatCalls,
    remove(relPath) {
      const target = path.join(WS, relPath);
      for (const key of [...nodes.keys()]) {
        if (key === target || key.startsWith(`${target}/`)) nodes.delete(key);
      }
    },
    async readdir(dir) {
      if (nodes.get(dir) !== 'dir') throw enoent(dir);
      const children = [];
      for (const [key, kind] of nodes) {
        if (path.dirname(key) !== dir || key === dir) continue;
        children.push({
          name: path.basename(key),
          isDirectory: () => kind === 'dir',
          isSymbolicLink: () => kind === 'symlink',
        });
      }
      return children;
    },
    async lstat(p) {
      lstatCalls.push(p);
      const kind = nodes.get(p);
      if (!kind) throw enoent(p);
      return { isDirectory: () => kind === 'dir' };
    },
  };
}

/** A fake `fs.watch` that records every watch and lets a test fire events or errors. */
function createFakeWatch({ failFor = () => null } = {}) {
  const created = [];
  function watch(dir, options, handler) {
    const failure = failFor(dir);
    if (failure) throw failure;
    const listeners = [];
    const watcher = {
      dir,
      options,
      handler,
      closed: false,
      on(event, listener) {
        if (event === 'error') listeners.push(listener);
        return this;
      },
      emitError(error) {
        for (const listener of listeners) listener(error);
      },
      close() {
        this.closed = true;
      },
    };
    created.push(watcher);
    return watcher;
  }
  const open = () => created.filter((w) => !w.closed);
  return {
    watch,
    created,
    open,
    openDirs: () => open().map((w) => w.dir).sort(),
    at: (dir) => open().find((w) => w.dir === dir) ?? null,
  };
}

/** A clock the test drives: `tick()` runs the next timer. */
function createFakeClock() {
  let timers = [];
  let nextId = 0;
  return {
    setTimeoutImpl: (fn, ms = 0) => {
      const timer = { fn, id: (nextId += 1), due: ms };
      timers.push(timer);
      return timer.id;
    },
    clearTimeoutImpl: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
    nowImpl: () => 0,
    tick() {
      const next = timers.reduce((a, t) => (a === null || t.due < a.due ? t : a), null);
      if (!next) return;
      timers = timers.filter((t) => t.id !== next.id);
      next.fn();
    },
  };
}

/** The walk is asynchronous; with the in-memory fs it ends within one turn. */
const settle = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A workspace watcher on `WS`, watched the Linux way over the stand-ins above. */
function setup({ entries = {}, failFor, maxWatchedDirectories } = {}) {
  const fs = createMemoryFs(entries);
  const fake = createFakeWatch({ failFor });
  const clock = createFakeClock();
  const reports = [];
  const errors = [];
  const watcher = createWorkspaceWatcher({
    watch: fake.watch,
    path,
    fs,
    platform: 'linux',
    onChange: (payload) => reports.push(payload),
    onError: (error, dir) => errors.push({ code: error.code, dir }),
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    nowImpl: clock.nowImpl,
    startRecheckMs: 0,
    ...(maxWatchedDirectories ? { maxWatchedDirectories } : {}),
  });
  /** Fires an event at the watch on `relDir`, as inotify reports it: by the child's name. */
  const fire = (relDir, name, eventType = 'rename') => {
    const dir = relDir ? path.join(WS, relDir) : WS;
    const target = fake.at(dir);
    assert.ok(target, `no open watch on ${dir}`);
    target.handler(eventType, name);
  };
  return { fs, fake, clock, reports, errors, watcher, fire };
}

module.exports = { WS, abs, path, createMemoryFs, createFakeWatch, createFakeClock, settle, setup };
