// The folder-by-folder watch (#648) at its cap: a folder that goes makes room
// again, and what was skipped stays skipped until the folder is watched afresh.

const test = require('node:test');
const assert = require('node:assert/strict');

const { WATCH_LIMIT_ERROR_CODE } = require('../src/main/services/directory-watcher');
const { WS, abs, settle, setup } = require('./helpers/linux-folder-watch');

/** The target plus four folders fill a cap of five; `e` and `f` are left over. */
function setupAtCap() {
  const entries = {};
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) entries[`${name}/x.txt`] = 'file';
  return setup({ entries, maxWatchedDirectories: 5 });
}

test('a folder that goes frees its watch, and the next new folder gets it (#648)', async () => {
  const { fs, fake, reports, errors, clock, watcher, fire } = setupAtCap();
  watcher.watchWorkspace(WS);
  await settle();
  clock.tick();

  assert.deepEqual(fake.openDirs(), [WS, abs('a'), abs('b'), abs('c'), abs('d')]);
  assert.deepEqual(errors, [{ code: WATCH_LIMIT_ERROR_CODE, dir: abs('e') }]);
  assert.deepEqual(reports, [{ directories: [], complete: false }], 'one coarse reload');

  // `rm -r a && mkdir g`
  fs.remove('a');
  fire('', 'a');
  fs.add('g', 'dir');
  fire('', 'g');
  await settle();
  clock.tick();

  assert.equal(fake.at(abs('a')), null, 'the folder that went has no watch');
  assert.ok(fake.at(abs('g')), 'the new folder has one');
  assert.deepEqual(reports.at(-1), { directories: [WS], complete: true });

  fs.add('g/new.txt', 'file');
  fire('g', 'new.txt');
  clock.tick();
  assert.deepEqual(reports.at(-1), { directories: [abs('g')], complete: true }, 'and it reports');
  assert.equal(errors.length, 1, 'nothing new to say');
  watcher.close();
});

test('folders skipped at the cap stay unwatched until the folder is watched afresh (#648)', async () => {
  const { fs, fake, clock, watcher, fire } = setupAtCap();
  watcher.watchWorkspace(WS);
  await settle();
  clock.tick();

  fs.remove('a');
  fire('', 'a');
  await settle();
  // The freed watch is not handed to a folder skipped before: nothing looks
  // for them. The tree reloaded coarsely when they were skipped.
  assert.equal(fake.at(abs('e')), null);
  assert.equal(fake.at(abs('f')), null);

  watcher.watchWorkspace(WS);
  await settle();
  assert.deepEqual(fake.openDirs(), [WS, abs('b'), abs('c'), abs('d'), abs('e')]);
  watcher.close();
});

test('with the cap still reached, a new folder is skipped and reported incomplete (#648)', async () => {
  const { fs, fake, reports, errors, clock, watcher, fire } = setupAtCap();
  watcher.watchWorkspace(WS);
  await settle();
  clock.tick();

  // One folder goes, two come: the first takes the freed watch.
  fs.remove('a');
  fire('', 'a');
  fs.add('g', 'dir');
  fire('', 'g');
  fs.add('h', 'dir');
  fire('', 'h');
  await settle();
  clock.tick();

  assert.ok(fake.at(abs('g')));
  assert.equal(fake.at(abs('h')), null);
  assert.deepEqual(reports.at(-1), { directories: [WS], complete: false });
  assert.deepEqual(errors.at(-1), { code: WATCH_LIMIT_ERROR_CODE, dir: abs('h') }, 'said again');
  watcher.close();
});
