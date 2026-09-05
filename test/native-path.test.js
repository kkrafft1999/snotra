const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Issue #73: Der Renderer bekommt native Pfade (Windows: Backslash) und darf
// sie nicht nur an "/" zerlegen. Beide Module sind natives ESM ohne Bundler.
const rendererModule = (...segments) =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', ...segments)).href);

const nativePathPromise = rendererModule('utils', 'nativePath.js');
const fileTreePromise = rendererModule('components', 'FileTree.js');

test('basenameOf handles POSIX and Windows paths alike', async () => {
  const { basenameOf } = await nativePathPromise;
  assert.equal(basenameOf('/Users/k/repo/src/app.js'), 'app.js');
  assert.equal(basenameOf('/Users/k/repo/'), 'repo');
  assert.equal(basenameOf('C:\\repo\\src\\app.js'), 'app.js');
  assert.equal(basenameOf('C:\\repo\\'), 'repo');
  assert.equal(basenameOf('\\\\server\\share\\docs\\a.md'), 'a.md');
  assert.equal(basenameOf('/'), '/');
  assert.equal(basenameOf('C:\\'), 'C:');
});

test('parentDirOf keeps the separator style of the input', async () => {
  const { parentDirOf } = await nativePathPromise;
  assert.equal(parentDirOf('/Users/k/repo/src/app.js'), '/Users/k/repo/src');
  assert.equal(parentDirOf('/Users'), '/');
  assert.equal(parentDirOf('/Users/k/repo/'), '/Users/k');
  assert.equal(parentDirOf('C:\\repo\\src\\app.js'), 'C:\\repo\\src');
  assert.equal(parentDirOf('C:\\repo'), 'C:\\');
  assert.equal(parentDirOf('C:\\repo\\'), 'C:\\');
  assert.equal(parentDirOf('\\\\server\\share\\docs\\a.md'), '\\\\server\\share\\docs');
  assert.equal(parentDirOf('app.js'), '/');
});

test('depthOf and separatorOf', async () => {
  const { depthOf, separatorOf } = await nativePathPromise;
  assert.equal(depthOf('/a/b/c'), 3);
  assert.equal(depthOf('C:\\a\\b\\c'), 4);
  assert.ok(depthOf('C:\\a') < depthOf('C:\\a\\b'));
  assert.equal(separatorOf('/a/b'), '/');
  assert.equal(separatorOf('C:\\a'), '\\');
  assert.equal(separatorOf('C:'), '\\');
  assert.equal(separatorOf('\\\\server\\share'), '\\');
});

test('joinNative appends a relative POSIX path in the style of the root', async () => {
  const { joinNative } = await nativePathPromise;
  assert.equal(joinNative('/Users/k/repo', 'src/app.js'), '/Users/k/repo/src/app.js');
  assert.equal(joinNative('/Users/k/repo/', './src/app.js'), '/Users/k/repo/src/app.js');
  assert.equal(joinNative('/', 'x.md'), '/x.md');
  assert.equal(joinNative('C:\\repo', 'src/app.js'), 'C:\\repo\\src\\app.js');
  assert.equal(joinNative('C:\\repo\\', 'src/app.js'), 'C:\\repo\\src\\app.js');
  assert.equal(joinNative('C:\\', 'x.md'), 'C:\\x.md');
  assert.equal(joinNative('C:\\repo', ''), 'C:\\repo');
});

test('FileTree helpers resolve parents and depth for Windows paths', async () => {
  const { parentDirFromItemPath, folderDepthSortKey } = await fileTreePromise;
  assert.equal(parentDirFromItemPath('C:\\repo\\src\\app.js'), 'C:\\repo\\src');
  assert.equal(parentDirFromItemPath('/repo/src/app.js'), '/repo/src');
  const sorted = ['C:\\r\\a\\b', 'C:\\r', 'C:\\r\\a'].sort((a, b) => folderDepthSortKey(a) - folderDepthSortKey(b));
  assert.deepEqual(sorted, ['C:\\r', 'C:\\r\\a', 'C:\\r\\a\\b']);
});

test('external write refresh: root + relative tool path matches the tree entry style', async () => {
  const { joinNative, parentDirOf } = await nativePathPromise;
  // Windows: Tool meldet "docs/neu.md", Baum-Einträge kommen aus path.join -> Backslash.
  const abs = joinNative('C:\\Users\\k\\repo', 'docs/neu.md');
  assert.equal(abs, 'C:\\Users\\k\\repo\\docs\\neu.md');
  assert.equal(parentDirOf(abs), 'C:\\Users\\k\\repo\\docs');
});
