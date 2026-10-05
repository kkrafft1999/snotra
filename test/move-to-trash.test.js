const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMoveToTrash, trashName } = require('../src/main/services/move-to-trash');

// 2026-10-05 08:45:12 local time — Finder's suffix is the local time of day.
const DATE = new Date(2026, 9, 5, 8, 45, 12);
// Creating a symlink on Windows needs a privilege the CI runner lacks.
const symlinksAllowed = { skip: process.platform === 'win32' ? 'symlinks need a privilege on Windows' : false };

const refused = () => {
  throw new Error('could not be moved to the trash because you don’t have permission');
};

async function setUp(t, { withTrash = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-trash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'OneDrive', 'Library - Shared');
  await fs.mkdir(workspace, { recursive: true });
  if (withTrash) await fs.mkdir(path.join(home, '.Trash'), { recursive: true });
  else await fs.mkdir(home, { recursive: true });
  const warnings = [];
  const make = (options = {}) => createMoveToTrash({
    trashItem: refused,
    platform: 'darwin',
    homedir: () => home,
    now: () => DATE,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    ...options,
  });
  return { home, trash: path.join(home, '.Trash'), workspace, warnings, make };
}

const exists = (p) => fs.lstat(p).then(() => true, () => false);

test('trashName: Finder-style names — as is, with the time, then counted (#712)', () => {
  assert.equal(trashName('ziel.svg', { date: DATE, attempt: 0 }), 'ziel.svg');
  assert.equal(trashName('ziel.svg', { date: DATE, attempt: 1 }), 'ziel 08.45.12.svg');
  assert.equal(trashName('ziel.svg', { date: DATE, attempt: 2 }), 'ziel 08.45.12 2.svg');
  assert.equal(trashName('archive.tar.gz', { date: DATE, attempt: 1 }), 'archive.tar 08.45.12.gz');
  assert.equal(trashName('.env', { date: DATE, attempt: 1 }), '.env 08.45.12');
  assert.equal(trashName('Makefile', { date: DATE, attempt: 3 }), 'Makefile 08.45.12 3');
  // A folder has no extension: "v1.2" stays whole.
  assert.equal(trashName('v1.2', { isDirectory: true, date: DATE, attempt: 1 }), 'v1.2 08.45.12');
});

test('moveToTrash: the trash API succeeding is the whole story (#712)', async (t) => {
  const { workspace, trash, make } = await setUp(t);
  const file = path.join(workspace, 'a.txt');
  await fs.writeFile(file, 'a');
  const trashed = [];
  await make({ trashItem: async (p) => trashed.push(p) })(file);
  assert.deepEqual(trashed, [file]);
  assert.equal(await exists(file), true, 'the stub did not move it, and neither did the fallback');
  assert.equal(await exists(path.join(trash, 'a.txt')), false);
});

test('moveToTrash on macOS: a refused trash moves the file into ~/.Trash (#712)', async (t) => {
  const { workspace, trash, warnings, make } = await setUp(t);
  const file = path.join(workspace, 'ziel.svg');
  await fs.writeFile(file, '<svg/>');
  await make()(file);
  assert.equal(await exists(file), false);
  assert.equal(await fs.readFile(path.join(trash, 'ziel.svg'), 'utf8'), '<svg/>');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /don’t have permission/, 'the refusal is logged, not swallowed');
});

test('moveToTrash on macOS: never replaces an entry already in the trash (#712)', async (t) => {
  const { workspace, trash, make } = await setUp(t);
  await fs.writeFile(path.join(trash, 'ziel.svg'), 'older');
  await fs.writeFile(path.join(trash, 'ziel 08.45.12.svg'), 'old');
  const file = path.join(workspace, 'ziel.svg');
  await fs.writeFile(file, 'new');
  await make()(file);
  assert.equal(await fs.readFile(path.join(trash, 'ziel.svg'), 'utf8'), 'older');
  assert.equal(await fs.readFile(path.join(trash, 'ziel 08.45.12.svg'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(trash, 'ziel 08.45.12 2.svg'), 'utf8'), 'new');
});

test('moveToTrash on macOS: a folder moves as a whole, its name not split (#712)', async (t) => {
  const { workspace, trash, make } = await setUp(t);
  await fs.mkdir(path.join(trash, 'v1.2'));
  const dir = path.join(workspace, 'v1.2');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'inner.md'), 'inner');
  await make()(dir);
  assert.equal(await exists(dir), false);
  assert.equal(await fs.readFile(path.join(trash, 'v1.2 08.45.12', 'inner.md'), 'utf8'), 'inner');
  assert.deepEqual(await fs.readdir(path.join(trash, 'v1.2')), [], 'the empty folder there is untouched');
});

test('moveToTrash on macOS: a dangling symlink in the trash counts as taken (#712)', symlinksAllowed, async (t) => {
  const { workspace, trash, make } = await setUp(t);
  await fs.symlink(path.join(trash, 'nowhere'), path.join(trash, 'a.txt'));
  const file = path.join(workspace, 'a.txt');
  await fs.writeFile(file, 'a');
  await make()(file);
  assert.equal(await fs.readFile(path.join(trash, 'a 08.45.12.txt'), 'utf8'), 'a');
  assert.equal((await fs.lstat(path.join(trash, 'a.txt'))).isSymbolicLink(), true);
});

test('moveToTrash: Windows and Linux keep the trash API’s error (#712)', async (t) => {
  for (const platform of ['win32', 'linux']) {
    const { workspace, trash, make } = await setUp(t);
    const file = path.join(workspace, 'a.txt');
    await fs.writeFile(file, 'a');
    await assert.rejects(make({ platform })(file), /don’t have permission/);
    assert.equal(await exists(file), true, platform);
    assert.deepEqual(await fs.readdir(trash), [], platform);
  }
});

test('moveToTrash on macOS: no ~/.Trash, no fallback — the original error stands (#712)', async (t) => {
  const { workspace, home, make } = await setUp(t, { withTrash: false });
  const file = path.join(workspace, 'a.txt');
  await fs.writeFile(file, 'a');
  await assert.rejects(make()(file), /don’t have permission/);
  assert.equal(await exists(file), true);
  assert.equal(await exists(path.join(home, '.Trash')), false, 'the trash is not created by us');
});

test('moveToTrash on macOS: a missing item keeps the original error (#712)', async (t) => {
  const { workspace, make } = await setUp(t);
  await assert.rejects(make()(path.join(workspace, 'gone.txt')), /don’t have permission/);
});

test('moveToTrash on macOS: another volume (EXDEV) keeps the original error, nothing is copied (#712)', async (t) => {
  const { workspace, trash, warnings, make } = await setUp(t);
  const file = path.join(workspace, 'a.txt');
  await fs.writeFile(file, 'a');
  const crossDevice = {
    ...fs,
    lstat: fs.lstat,
    stat: fs.stat,
    rename: async () => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    },
  };
  await assert.rejects(make({ fs: crossDevice })(file), /don’t have permission/);
  assert.equal(await exists(file), true);
  assert.deepEqual(await fs.readdir(trash), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EXDEV/);
});

test('moveToTrash on macOS: an item already in the trash is not moved around in it (#712)', async (t) => {
  const { trash, make } = await setUp(t);
  const file = path.join(trash, 'a.txt');
  await fs.writeFile(file, 'a');
  await assert.rejects(make()(file), /don’t have permission/);
  assert.deepEqual(await fs.readdir(trash), ['a.txt']);
});

test('createMoveToTrash needs the trash API to start from', () => {
  assert.throws(() => createMoveToTrash({}), TypeError);
});
