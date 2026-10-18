// Test folders are removed with retries, so a handle that is still closing on
// Windows cannot turn a passing test red (#1132).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { removeTempDir, removeTempDirSync, removeDir } = require('./helpers/temp-dir');

// A path `rm` rejects on every platform, standing in for a folder Windows
// keeps busy past the last retry.
const UNREMOVABLE = path.join(os.tmpdir(), 'snotra-temp-dir-\0-test');

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-temp-dir-test-'));
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'file.txt'), 'x');
  return dir;
}

test('removeTempDir and removeTempDirSync remove a tree, and a gone folder is fine', async () => {
  const dir = makeTree();
  await removeTempDir(dir);
  assert.equal(fs.existsSync(dir), false);
  await removeTempDir(dir);

  const other = makeTree();
  removeTempDirSync(other);
  assert.equal(fs.existsSync(other), false);
  removeTempDirSync(other);
});

test('a folder the cleanup cannot remove is left behind with a warning, not thrown', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  await removeTempDir(UNREMOVABLE);
  removeTempDirSync(UNREMOVABLE);

  assert.equal(warn.mock.callCount(), 2);
  assert.match(warn.mock.calls[0].arguments[0], /left .*snotra-temp-dir-.* behind/);
});

test('removeDir removes a folder as a test step and throws when it cannot', async () => {
  const dir = makeTree();
  await removeDir(dir);
  assert.equal(fs.existsSync(dir), false);

  await assert.rejects(removeDir(UNREMOVABLE));
});

// Deliberately rough, like the other source guards: one line at a time, so a
// call spread over several lines slips through.
const RECURSIVE_RM = /\brm(?:Sync)?\((?:[^()]|\([^()]*\))*\{[^}]*\brecursive\b/;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(c|m)?js$/.test(entry.name) ? [full] : [];
  });
}

test('the guard pattern tells a bare recursive rm from one that retries', () => {
  // Assembled, so the guard below does not find them in this file.
  assert.match('  t.after(() => fs.rm' + '(dir, { recursive: true, force: true }));', RECURSIVE_RM);
  assert.match('  fs.rmSync' + '(path.join(dir, "x"), { recursive: true });', RECURSIVE_RM);
  assert.doesNotMatch('  t.after(() => removeTempDir(dir));', RECURSIVE_RM);
  assert.doesNotMatch('  await fs.mkdir(dir, { recursive: true });', RECURSIVE_RM);
});

test('every recursive rm in test/ and e2e/ retries', () => {
  const root = path.join(__dirname, '..');
  const offenders = ['test', 'e2e']
    .flatMap((dir) => sourceFiles(path.join(root, dir)))
    .flatMap((file) => stripComments(fs.readFileSync(file, 'utf8')).split('\n')
      .map((line, i) => ({ where: `${path.relative(root, file)}:${i + 1}`, line })))
    .filter(({ line }) => RECURSIVE_RM.test(line) && !/\bmaxRetries\b/.test(line))
    .map(({ where }) => where);
  assert.deepEqual(offenders, [],
    'clean up with removeTempDir()/removeTempDirSync() and remove as a step with removeDir() from test/helpers/temp-dir.js');
});
