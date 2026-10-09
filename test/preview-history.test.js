// Back and forward through the files the preview showed (#822): the rules of
// the list, without a pane.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer } = require('./helpers/dom.js');

const load = async (options) => {
  const { createPreviewHistory } = await importRenderer('file-views', 'preview-history.js');
  return createPreviewHistory(options);
};
const ROOT = '/ws';
const isInside = (child, dir) => child.startsWith(`${dir}/`);
const paths = (history, direction) => history.list(direction).map((entry) => entry.path);

test('every file shown is a step; the same file again is not', async () => {
  const history = await load();
  history.visit('/ws/a.md', { workspaceRoot: ROOT });
  history.visit('/ws/a.md', { workspaceRoot: ROOT });
  history.visit('/ws/b.md', { workspaceRoot: ROOT });
  assert.equal(history.size, 2);
  assert.equal(history.current.path, '/ws/b.md');
  assert.equal(history.canGo(-1), true);
  assert.equal(history.canGo(1), false);
  assert.equal(history.step(-1).entry.path, '/ws/a.md');
});

test('going back and on to another file drops what lay ahead', async () => {
  const history = await load();
  for (const name of ['a', 'b', 'c']) history.visit(`/ws/${name}.md`, { workspaceRoot: ROOT });
  const back = history.step(-1);
  history.visit(back.entry.path, { workspaceRoot: ROOT, target: back.index });
  assert.equal(history.current.path, '/ws/b.md');
  assert.deepEqual(paths(history, 1), ['/ws/c.md']);

  history.visit('/ws/d.md', { workspaceRoot: ROOT });
  assert.deepEqual(paths(history, -1), ['/ws/b.md', '/ws/a.md']);
  assert.equal(history.canGo(1), false);
});

test('a step back and forward keeps the list as it is', async () => {
  const history = await load();
  for (const name of ['a', 'b', 'c']) history.visit(`/ws/${name}.md`, { workspaceRoot: ROOT });
  let step = history.step(-1);
  history.visit(step.entry.path, { workspaceRoot: ROOT, target: step.index });
  step = history.step(-1);
  history.visit(step.entry.path, { workspaceRoot: ROOT, target: step.index });
  assert.equal(history.current.path, '/ws/a.md');
  step = history.step(1);
  history.visit(step.entry.path, { workspaceRoot: ROOT, target: step.index });
  assert.equal(history.current.path, '/ws/b.md');
  assert.equal(history.size, 3);
});

test('each entry keeps what its view reported, and the fragment it was opened with', async () => {
  const history = await load();
  history.visit('/ws/a.md', { workspaceRoot: ROOT });
  history.saveFragment('/ws/a.md', 'setup');
  history.saveState('/ws/a.md', { top: 420 });
  // Only the current entry takes it: a late report for another file is dropped.
  history.saveState('/ws/b.md', { top: 1 });
  history.visit('/ws/b.md', { workspaceRoot: ROOT });
  assert.deepEqual(history.step(-1).entry, { path: '/ws/a.md', state: { top: 420 }, fragment: 'setup', gone: false });
  assert.equal(history.current.state, null);
});

test('an entry that is gone is skipped, and listed as gone', async () => {
  const history = await load();
  for (const name of ['a', 'b', 'c']) history.visit(`/ws/${name}.md`, { workspaceRoot: ROOT });
  history.markGone('/ws/b.md');
  assert.equal(history.step(-1).entry.path, '/ws/a.md');
  assert.deepEqual(history.list(-1).map((entry) => entry.gone), [true, false]);

  history.markGone('/ws/a.md');
  assert.equal(history.canGo(-1), false);
  assert.equal(history.step(-1), null);
});

test('a deleted folder takes every entry inside it along', async () => {
  const history = await load();
  for (const path of ['/ws/docs/a.md', '/ws/docs/sub/b.md', '/ws/docs-old.md', '/ws/c.md']) {
    history.visit(path, { workspaceRoot: ROOT });
  }
  history.markGoneUnder('/ws/docs', isInside);
  assert.deepEqual(history.list(-1).map((entry) => [entry.path, entry.gone]), [
    ['/ws/docs-old.md', false],
    ['/ws/docs/sub/b.md', true],
    ['/ws/docs/a.md', true],
  ]);
});

test('a rename or move in the tree is followed, files inside a folder too', async () => {
  const history = await load();
  for (const path of ['/ws/docs/a.md', '/ws/docs/sub/b.md', '/ws/c.md']) history.visit(path, { workspaceRoot: ROOT });
  history.rename('/ws/docs', '/ws/guide', isInside);
  history.rename('/ws/c.md', '/ws/d.md', isInside);
  assert.equal(history.current.path, '/ws/d.md');
  assert.deepEqual(paths(history, -1), ['/ws/guide/sub/b.md', '/ws/guide/a.md']);
});

test('a picked entry that was gone and is shown again counts as there', async () => {
  const history = await load();
  for (const name of ['a', 'b']) history.visit(`/ws/${name}.md`, { workspaceRoot: ROOT });
  history.markGone('/ws/a.md');
  history.visit('/ws/a.md', { workspaceRoot: ROOT, target: 0 });
  assert.equal(history.current.path, '/ws/a.md');
  assert.equal(history.current.gone, false);
  assert.equal(history.size, 2);
});

test('another folder starts an empty list', async () => {
  const history = await load();
  history.visit('/ws/a.md', { workspaceRoot: ROOT });
  history.visit('/other/x.md', { workspaceRoot: '/other' });
  assert.equal(history.size, 1);
  assert.equal(history.canGo(-1), false);

  history.reset();
  assert.equal(history.size, 0);
  assert.equal(history.current, null);
});

test('the list keeps the last fifty entries', async () => {
  const history = await load();
  for (let i = 0; i < 60; i += 1) history.visit(`/ws/${i}.md`, { workspaceRoot: ROOT });
  assert.equal(history.size, 50);
  assert.equal(history.current.path, '/ws/59.md');
  const back = history.list(-1);
  assert.equal(back.at(-1).path, '/ws/10.md');
  assert.equal(back.at(-1).index, 0);
});

test('a target that no longer matches its path is a new step', async () => {
  const history = await load();
  for (const name of ['a', 'b']) history.visit(`/ws/${name}.md`, { workspaceRoot: ROOT });
  history.visit('/ws/z.md', { workspaceRoot: ROOT, target: 0 });
  assert.equal(history.current.path, '/ws/z.md');
  assert.equal(history.size, 3);
});
