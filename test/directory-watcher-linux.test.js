// The folder-by-folder watch Linux gets instead of `recursive: true` (#648).
//
// Driven with a fake `fs.watch` and an in-memory file system on every OS, so
// the logic is pinned down everywhere. Whether real inotify behaves the way
// this relies on is answered by workspace-watcher-real-fs.test.js, which runs
// the same scenario against the real file system.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDirectoryWatcher, WATCH_LIMIT_ERROR_CODE } = require('../src/main/services/directory-watcher');
const { WS, abs, path, createFakeWatch, settle, setup } = require('./helpers/linux-folder-watch');

test('every folder gets a plain watch of its own, nothing recursive (#648)', async () => {
  const { fake, watcher } = setup({
    entries: { 'src/app.js': 'file', 'src/lib/util.js': 'file', 'docs/a.md': 'file', 'README.md': 'file' },
  });
  watcher.watchWorkspace(WS);
  await settle();

  assert.deepEqual(fake.openDirs(), [WS, abs('docs'), abs('src'), abs('src', 'lib')]);
  assert.ok(fake.created.every((w) => w.options.recursive === false), 'no recursive watch anywhere');
  // To the outside it is still one target.
  assert.deepEqual(watcher.watchedDirectories(), [{ dir: WS, isTarget: true }]);
  watcher.close();
});

test('a node_modules of 20,000 files costs no watch, .git one flat watch (#648)', async () => {
  const entries = { 'src/index.js': 'file', '.git/HEAD': 'file', '.git/objects/ab/cdef': 'file', '.git/refs/heads/main': 'file' };
  for (let p = 0; p < 1000; p += 1) {
    for (let d = 0; d < 5; d += 1) {
      for (let f = 0; f < 4; f += 1) entries[`node_modules/pkg${p}/d${d}/f${f}.js`] = 'file';
    }
  }
  entries['packages/app/node_modules/left-pad/index.js'] = 'file';
  const { fake, watcher } = setup({ entries });
  watcher.watchWorkspace(WS);
  await settle();

  assert.deepEqual(fake.openDirs(), [WS, abs('.git'), abs('packages'), abs('packages', 'app'), abs('src')]);
  watcher.close();
});

test('a file replaced by rename and then appended to is reported both times (#648)', async () => {
  const { reports, clock, watcher, fire } = setup({ entries: { 'notes/plan.md': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();

  // What `writeFileAtomic` does: a temporary file renamed onto the target.
  fire('notes', '.plan.md.snotra-tmp-1');
  fire('notes', 'plan.md');
  clock.tick();
  // The folder's watch does not care about the file's inode: the append that
  // Node's emulation lost arrives by name.
  fire('notes', 'plan.md', 'change');
  clock.tick();

  assert.deepEqual(reports, [
    { directories: [abs('notes')], complete: true },
    { directories: [abs('notes')], complete: true },
  ]);
  watcher.close();
});

test('a new folder gets a watch, and what landed in it before is reported (#648)', async () => {
  const { fs, fake, reports, clock, watcher, fire } = setup();
  watcher.watchWorkspace(WS);
  await settle();

  // `mkdir -p out/deep && touch out/deep/x.txt` — all of it before the
  // watcher heard of `out`.
  fs.add('out/deep/x.txt', 'file');
  fire('', 'out');
  await settle();
  clock.tick();

  assert.deepEqual(fake.openDirs(), [WS, abs('out'), abs('out', 'deep')]);
  assert.equal(reports.length, 1);
  assert.deepEqual([...reports[0].directories].sort(), [WS, abs('out'), abs('out', 'deep')]);
  assert.equal(reports[0].complete, true);
  watcher.close();
});

test('a folder that goes takes its watches and those below it along (#648)', async () => {
  const { fs, fake, watcher, fire } = setup({ entries: { 'out/deep/x.txt': 'file', 'src/a.js': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();
  const outWatch = fake.at(abs('out'));
  const deepWatch = fake.at(abs('out', 'deep'));

  fs.remove('out');
  fire('', 'out');
  await settle();

  assert.equal(outWatch.closed, true);
  assert.equal(deepWatch.closed, true);
  assert.deepEqual(fake.openDirs(), [WS, abs('src')]);
  watcher.close();
});

test('a folder removed and made again under the same name is watched anew (#648)', async () => {
  const { fs, fake, watcher, fire } = setup({ entries: { 'dist/old.js': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();
  const oldWatch = fake.at(abs('dist'));

  // `rm -rf dist && mkdir dist`, both renames checked only after the second:
  // the old watch sits on a folder that no longer exists.
  fs.remove('dist');
  fs.add('dist/new.js', 'file');
  fire('', 'dist');
  fire('', 'dist');
  await settle();

  assert.equal(oldWatch.closed, true, 'the watch on the old folder is closed');
  assert.ok(fake.at(abs('dist')), 'the new folder has a watch');
  assert.notEqual(fake.at(abs('dist')), oldWatch);
  watcher.close();
});

test('a linked folder is not followed (#648)', async () => {
  const { fake, watcher } = setup({ entries: { 'src/a.js': 'file', 'linked': 'symlink' } });
  watcher.watchWorkspace(WS);
  await settle();
  assert.deepEqual(fake.openDirs(), [WS, abs('src')]);
  watcher.close();
});

test('.git is watched on its own, and a branch switch reports every time (#648)', async () => {
  const { reports, clock, watcher, fire } = setup({ entries: { '.git/HEAD': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();

  for (let i = 0; i < 3; i += 1) {
    // git's way: write HEAD.lock, rename it onto HEAD.
    fire('.git', 'HEAD.lock');
    fire('.git', 'HEAD');
    clock.tick();
  }
  assert.deepEqual(reports, [
    { directories: [], complete: false },
    { directories: [], complete: false },
    { directories: [], complete: false },
  ]);
  watcher.close();
});

test('at the cap, the watcher says so and the receiver reloads coarsely (#648)', async () => {
  const { fake, reports, errors, clock, watcher } = setup({
    entries: { 'a/x': 'file', 'b/x': 'file', 'c/x': 'file', 'd/x': 'file' },
    maxWatchedDirectories: 3,
  });
  watcher.watchWorkspace(WS);
  await settle();
  clock.tick();

  assert.equal(fake.open().length, 3, 'no watch beyond the cap');
  assert.equal(errors.length, 1, 'said once');
  assert.equal(errors[0].code, WATCH_LIMIT_ERROR_CODE);
  assert.equal(errors[0].dir, abs('c'), 'names the first folder left without a watch');
  assert.deepEqual(reports, [{ directories: [], complete: false }]);
  watcher.close();
});

test('the kernel out of watches is reported with the folder, and the walk stops (#648)', async () => {
  let attempts = 0;
  const { reports, errors, clock, watcher } = setup({
    entries: { 'a/x': 'file', 'b/x': 'file', 'c/x': 'file' },
    failFor: (dir) => {
      if (dir === WS) return null;
      attempts += 1;
      return Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {
        code: 'ENOSPC',
      });
    },
  });
  watcher.watchWorkspace(WS);
  await settle();
  clock.tick();

  assert.deepEqual(errors, [{ code: 'ENOSPC', dir: abs('a') }]);
  assert.equal(attempts, 1, 'the next folder would only fail the same way');
  assert.deepEqual(reports, [{ directories: [], complete: false }]);
  watcher.close();
});

test('an error on a folder watch names that folder and reports incomplete (#648)', async () => {
  const { fake, reports, errors, clock, watcher } = setup({ entries: { 'src/lib/a.js': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();

  const failing = fake.at(abs('src', 'lib'));
  failing.emitError(Object.assign(new Error('watch failed'), { code: 'EIO' }));
  clock.tick();

  assert.deepEqual(errors, [{ code: 'EIO', dir: abs('src', 'lib') }]);
  assert.equal(failing.closed, true);
  assert.deepEqual(reports, [{ directories: [], complete: false }]);
  watcher.close();
});

test('close() ends every folder watch (#648)', async () => {
  const { fake, watcher } = setup({ entries: { 'src/lib/a.js': 'file', 'docs/a.md': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();
  assert.equal(fake.open().length, 4);
  watcher.close();
  assert.equal(fake.open().length, 0);
});

test('an error on an ancestor watch names the ancestor, not the top of the chain (#648)', () => {
  const fake = createFakeWatch();
  const errors = [];
  const watcher = createDirectoryWatcher({
    watch: fake.watch,
    path,
    platform: 'darwin',
    resolveTargets: () => [{ dir: path.join(WS, '.agents', 'skills'), fallbackLevels: 2 }],
    onChange: () => {},
    onError: (error, dir) => errors.push(`${error.message} -> ${dir}`),
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
    startRecheckMs: 0,
  });
  watcher.watchWorkspace(WS);
  for (const w of fake.open()) w.emitError(new Error(`error on ${w.dir}`));

  assert.deepEqual(errors, fake.open().map((w) => `error on ${w.dir} -> ${w.dir}`));
  assert.equal(errors.length, 3);
  watcher.close();
});
