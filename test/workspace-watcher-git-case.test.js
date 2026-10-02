// `.git` in another case (#648). The listing hides `.GIT` and `.Git` as it
// hides `.git` (`hidden-entries.js` ignores case), so the watcher has to treat
// their content as noise too, and on Linux keep its watches out of them.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isIgnoredWorkspacePath, isGitSignal } = require('../src/main/services/workspace-watcher');
const { WS, abs, path, settle, setup } = require('./helpers/linux-folder-watch');

test('the content of .git and node_modules is noise in any case (#648)', () => {
  assert.equal(isIgnoredWorkspacePath(path.join('.GIT', 'objects', 'ab', 'cdef')), true);
  assert.equal(isIgnoredWorkspacePath(path.join('.Git', 'refs', 'heads', 'main')), true);
  assert.equal(isIgnoredWorkspacePath(path.join('Node_Modules', 'left-pad', 'index.js')), true);
  assert.equal(isIgnoredWorkspacePath('Node_Modules'), false, 'the folder itself is listed');
  assert.equal(isIgnoredWorkspacePath(path.join('src', 'git.js')), false);
});

test('the git signals get out of .git in any case, by their exact names (#648)', () => {
  assert.equal(isGitSignal(path.join('.GIT', 'HEAD')), true);
  assert.equal(isGitSignal(path.join('.Git', 'index')), true);
  assert.equal(isGitSignal(path.join('.GIT', 'ORIG_HEAD')), true);
  // git writes these names in this case and no other.
  assert.equal(isGitSignal(path.join('.git', 'head')), false);
  assert.equal(isIgnoredWorkspacePath(path.join('.GIT', 'HEAD')), false);
  assert.equal(isIgnoredWorkspacePath(path.join('.GIT', 'head')), true);
});

test('on Linux, .GIT is watched flat and NODE_MODULES not at all (#648)', async () => {
  const { fake, reports, clock, watcher, fire } = setup({
    entries: {
      '.GIT/HEAD': 'file',
      '.GIT/objects/ab/cdef': 'file',
      '.GIT/refs/heads/main': 'file',
      'NODE_MODULES/left-pad/index.js': 'file',
      'src/a.js': 'file',
    },
  });
  watcher.watchWorkspace(WS);
  await settle();

  assert.deepEqual(fake.openDirs(), [WS, abs('.GIT'), abs('src')]);
  assert.equal(fake.at(abs('.GIT')).options.recursive, false);

  // A new pack in .GIT is noise; a branch switch is the signal.
  fire('.GIT', 'objects');
  clock.tick();
  assert.deepEqual(reports, []);
  fire('.GIT', 'HEAD.lock');
  fire('.GIT', 'HEAD');
  clock.tick();
  assert.deepEqual(reports, [{ directories: [], complete: false }]);
  watcher.close();
});
