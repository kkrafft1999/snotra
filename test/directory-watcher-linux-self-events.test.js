// What inotify reports about a watched folder itself (#648). A chmod, a
// removal or a move of the folder arrives at its own watch without a name,
// and libuv fills in the folder's basename — the watch on `app` reports
// `app`, as if a child `app/app` had changed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { WS, abs, path, settle, setup } = require('./helpers/linux-folder-watch');

test("a folder's own event is reported as the folder, not as a child of its name (#648)", async () => {
  const { fs, fake, reports, clock, watcher, fire } = setup({ entries: { 'app/index.js': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();
  const watches = fake.created.length;

  fire('app', 'app');
  await settle();
  clock.tick();

  // The folder is an entry of its parent: that is the listing to reload.
  assert.deepEqual(reports, [{ directories: [WS], complete: true }]);
  // Looked up once to tell the two apart — and not checked as a renamed child.
  assert.deepEqual(fs.lstatCalls.filter((p) => p === abs('app', 'app')), [abs('app', 'app')]);
  assert.equal(fake.created.length, watches, 'no watch set or reset');
  watcher.close();
});

test('a folder moved away does not report a folder that is not there (#648)', async () => {
  const { fs, fake, reports, clock, watcher, fire } = setup({ entries: { 'app/index.js': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();

  // `mv app moved`, as inotify tells it: the parent sees both names, the
  // folder's own watch sees itself go.
  fs.remove('app');
  fs.add('moved/index.js', 'file');
  fire('', 'app');
  fire('', 'moved');
  fire('app', 'app');
  await settle();
  clock.tick();

  assert.equal(reports.length, 1);
  assert.deepEqual([...reports[0].directories].sort(), [WS, abs('moved')]);
  assert.equal(reports[0].complete, true);
  assert.equal(fake.at(abs('app')), null);
  assert.ok(fake.at(abs('moved')));
  watcher.close();
});

test('a child that has its folder\'s name is still a child (#648)', async () => {
  const { reports, fake, clock, watcher, fire } = setup({ entries: { 'app/app/index.js': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();
  const before = fake.at(abs('app', 'app'));

  fire('app', 'app');
  await settle();
  clock.tick();

  assert.equal(reports.length, 1);
  assert.deepEqual([...reports[0].directories].sort(), [abs('app'), abs('app', 'app')]);
  assert.notEqual(fake.at(abs('app', 'app')), before, 'checked like any renamed child');
  watcher.close();
});

test("the target's own event has no folder in the tree to name (#648)", async () => {
  const { reports, clock, watcher, fire } = setup({ entries: { 'src/a.js': 'file' } });
  watcher.watchWorkspace(WS);
  await settle();

  fire('', path.basename(WS));
  await settle();
  clock.tick();

  assert.deepEqual(reports, [{ directories: [], complete: false }]);
  watcher.close();
});
