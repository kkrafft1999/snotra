// The watcher and the listing agree on what is noise (#650), and all three
// git signal files get through.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path').posix;

const { isIgnoredWorkspacePath, createWorkspaceWatcher } = require('../src/main/services/workspace-watcher');
const { ALWAYS_HIDDEN_ENTRY_NAMES, isListedEntryName } = require('../src/shared/runtime/hidden-entries');

const WS = path.join(path.sep, 'projects', 'demo');

/** Names the listing shows and names it never shows, with case variants and editor leftovers. */
const NAMES = [
  ...ALWAYS_HIDDEN_ENTRY_NAMES,
  ...ALWAYS_HIDDEN_ENTRY_NAMES.map((name) => name.toUpperCase()),
  'README.md',
  '.env',
  '.gitignore',
  '.github',
  'notes.md~',
  '.notes.md.swp',
  '.notes.md.swx',
  '4913',
  'swap.js',
  'node_modules',
];

test('the watcher ignores exactly the entries the listing never shows (#650)', () => {
  for (const name of NAMES) {
    // Never shown means: not even with hidden files switched on.
    const neverListed = !isListedEntryName(name, { showHidden: true });
    for (const relativePath of [name, path.join('src', name), `src\\deep\\${name}`]) {
      assert.equal(
        isIgnoredWorkspacePath(relativePath),
        neverListed,
        `${relativePath}: ${neverListed ? 'never listed, so ignored' : 'listed, so reported'}`
      );
    }
  }
});

test('removing an editor backup reaches the tree, Thumbs.db does not (#650)', () => {
  let report = null;
  let handler = null;
  let pending = null;
  const watcher = createWorkspaceWatcher({
    watch: (_dir, _options, h) => {
      handler = h;
      return { on() { return this; }, close() {} };
    },
    path,
    platform: 'darwin',
    onChange: (payload) => {
      report = payload;
    },
    setTimeoutImpl: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimeoutImpl: () => {
      pending = null;
    },
    nowImpl: () => 0,
    startRecheckMs: 0,
  });
  watcher.watchWorkspace(WS);

  handler('rename', path.join('docs', 'Thumbs.db'));
  handler('rename', 'desktop.ini');
  assert.equal(pending, null, 'system noise sets no timer at all');

  // `rm notes.md~` in a terminal: the row has to go.
  handler('rename', path.join('docs', 'notes.md~'));
  pending();
  assert.deepEqual(report, { directories: [path.join(WS, 'docs')], complete: true });
  watcher.close();
});

test('all three git signal files report as incomplete, ORIG_HEAD included (#650)', () => {
  for (const signal of ['HEAD', 'index', 'ORIG_HEAD']) {
    let report = null;
    let handler = null;
    let pending = null;
    const watcher = createWorkspaceWatcher({
      watch: (_dir, _options, h) => {
        handler = h;
        return { on() { return this; }, close() {} };
      },
      path,
      platform: 'darwin',
      onChange: (payload) => {
        report = payload;
      },
      setTimeoutImpl: (fn) => {
        pending = fn;
        return 1;
      },
      clearTimeoutImpl: () => {
        pending = null;
      },
      nowImpl: () => 0,
      startRecheckMs: 0,
    });
    watcher.watchWorkspace(WS);
    handler('rename', path.join('.git', signal));
    assert.ok(pending, `${signal} sets the timer`);
    pending();
    assert.deepEqual(report, { directories: [], complete: false }, signal);
    watcher.close();
  }
});
