// Which file view takes which file (#225). DOM-free: the registry decides
// before anything is mounted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer } = require('./helpers/dom.js');

const load = () => importRenderer('file-views', 'registry.js');

const fakeView = (id, { kind = 'viewer', exts = [] } = {}) => ({
  id,
  kind,
  canHandle: ({ ext }) => exts.includes(ext),
  mount: () => ({ update() {}, unmount() {} }),
});

test('the app registry sends text files to the plain-text view', async () => {
  const { fileViews } = await load();
  for (const name of ['README.md', 'app.JS', 'notes.txt', 'data.csv']) {
    assert.equal(fileViews.resolve({ name, size: 1 })?.id, 'plain-text', name);
  }
});

test('names without an extension are recognised the way isTextFile knows them', async () => {
  const { fileViews } = await load();
  for (const name of ['Makefile', 'LICENSE', 'Dockerfile', 'CHANGELOG']) {
    assert.equal(fileViews.resolve({ name })?.id, 'plain-text', name);
  }
});

test('a file no view claims resolves to null, so the pane falls back to the info card', async () => {
  const { fileViews } = await load();
  assert.equal(fileViews.resolve({ name: 'photo.png' }), null);
  assert.equal(fileViews.resolve({ name: 'archive.zip' }), null);
  assert.deepEqual(fileViews.candidatesFor({ name: 'photo.png' }), []);
});

test('canHandle sees name, lower-case extension, size and an open mime slot', async () => {
  const { createFileViewRegistry, describeFile } = await load();
  const seen = [];
  const registry = createFileViewRegistry([
    { ...fakeView('spy'), canHandle: (file) => { seen.push(file); return false; } },
  ]);
  registry.resolve({ path: '/ws/Guide.MD', name: 'Guide.MD', size: 42, modified: 7 });
  assert.deepEqual(seen, [{ name: 'Guide.MD', ext: 'md', size: 42, mime: undefined }]);
  assert.deepEqual(describeFile({ name: 'Makefile' }), { name: 'Makefile', ext: '', size: undefined, mime: undefined });
});

test('the first view that can handle a file wins, in registry order', async () => {
  const { createFileViewRegistry } = await load();
  const registry = createFileViewRegistry([
    fakeView('markdown', { exts: ['md'] }),
    fakeView('markdown-editor', { kind: 'editor', exts: ['md'] }),
    fakeView('text', { exts: ['md', 'txt'] }),
  ]);
  assert.equal(registry.resolve({ name: 'a.md' }).id, 'markdown');
  assert.equal(registry.resolve({ name: 'a.txt' }).id, 'text');
  assert.deepEqual(registry.candidatesFor({ name: 'a.md' }).map((v) => v.id), ['markdown', 'markdown-editor', 'text']);
});

test('a preferred id picks among the candidates, and is ignored when it cannot handle the file', async () => {
  const { createFileViewRegistry } = await load();
  const registry = createFileViewRegistry([
    fakeView('markdown', { exts: ['md'] }),
    fakeView('markdown-editor', { kind: 'editor', exts: ['md'] }),
    fakeView('text', { exts: ['txt'] }),
  ]);
  assert.equal(registry.resolve({ name: 'a.md' }, 'markdown-editor').id, 'markdown-editor');
  assert.equal(registry.resolve({ name: 'a.txt' }, 'markdown-editor').id, 'text');
  assert.equal(registry.resolve({ name: 'a.md' }, 'no-such-view').id, 'markdown');
});

test('a broken descriptor fails when the registry is built, not when a file is clicked', async () => {
  const { createFileViewRegistry } = await load();
  assert.throws(() => createFileViewRegistry([fakeView('')]), /non-empty string id/);
  assert.throws(() => createFileViewRegistry([fakeView('x', { kind: 'preview' })]), /viewer or editor/);
  assert.throws(() => createFileViewRegistry([{ ...fakeView('x'), mount: undefined }]), /missing mount/);
  assert.throws(() => createFileViewRegistry([{ ...fakeView('x'), canHandle: null }]), /missing canHandle/);
  assert.throws(() => createFileViewRegistry([fakeView('x'), fakeView('x')]), /registered twice/);
});

test('the order is fixed once the registry is built', async () => {
  const { createFileViewRegistry } = await load();
  const views = [fakeView('a', { exts: ['txt'] })];
  const registry = createFileViewRegistry(views);
  views.unshift(fakeView('b', { exts: ['txt'] }));
  assert.equal(registry.resolve({ name: 'x.txt' }).id, 'a');
  assert.throws(() => registry.views.push(fakeView('c')), TypeError);
});
