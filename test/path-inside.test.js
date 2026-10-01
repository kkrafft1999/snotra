const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isPathInside } = require('../src/shared/runtime/path-inside');
const { createNodeWorkspacePathAdapter } = require('../src/main/adapters/workspace-path-adapter');

// #555: `..` is outside only as a whole segment; a name that begins with two
// dots is inside like any other.
test('isPathInside reads `..` only as a whole segment (#555)', () => {
  for (const mod of [path.posix, path.win32]) {
    const root = mod === path.win32 ? 'C:\\work\\proj' : '/work/proj';
    const inside = (...parts) => isPathInside(mod, root, mod.join(root, ...parts));
    assert.equal(isPathInside(mod, root, root), true, 'the root itself');
    assert.equal(inside('src', 'a.js'), true);
    assert.equal(inside('..cache'), true);
    assert.equal(inside('..cache', 'x'), true);
    assert.equal(inside('..'), false);
    assert.equal(inside('..', 'other'), false);
  }
  assert.equal(isPathInside(path.win32, 'C:\\work', 'D:\\work\\a'), false, 'another drive');
});

test('a selection inside the folder may begin with two dots (#555)', () => {
  const adapter = createNodeWorkspacePathAdapter({ path: path.posix });
  assert.deepEqual(adapter.resolveSelection('/work/proj', '..cache/a.md', false), { relativePath: '..cache/a.md', isDirectory: false });
  assert.equal(adapter.resolveSelection('/work/proj', '../other/a.md', false), null);
});
