'use strict';

// The README a folder opens with (#351), on the real tree: found among the
// rows of the top level, read once, shown without being selected.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

async function mountTree(entries, { readFile } = {}) {
  const dom = setupRendererDom();
  const { initFileTree } = await importRenderer('components', 'FileTree.js');
  const { appStore } = await importRenderer('state', 'store.js');
  appStore.rootPath = null;
  appStore.activeTreeItem = null;
  appStore.selectedPath = null;
  appStore.selectedIsDirectory = false;
  appStore.showHiddenFiles = false;

  const reads = [];
  const api = {
    activateFolder: async () => ({ ok: true }),
    getFolderHistory: async () => ({ paths: [] }),
    readDirectory: async (dir) => ({ entries: entries[dir] ?? [], hidden: 0 }),
    readFile: async (filePath) => {
      reads.push(filePath);
      return readFile ? readFile(filePath) : { content: `# ${filePath}`, size: 12 };
    },
    onFsTreeChanged: () => () => {},
    onFsItemDeleted: () => {},
    showFileContextMenu: async () => ({}),
  };
  const tree = initFileTree({
    api,
    appStore,
    onInputChanged() {},
    onWorkspaceChanged() {},
    onProjectOpened() {},
    sendChatMessage() {},
    activeProviderConfigured: () => true,
  });
  return { dom, tree, appStore, reads, container: document.getElementById('tree-container') };
}

const file = (dir, name) => ({ name, path: `${dir}/${name}`, isDirectory: false, size: 12, modified: 0 });
const folder = (dir, name) => ({ name, path: `${dir}/${name}`, isDirectory: true });
const shownPath = () => document.getElementById('preview-filename')?.textContent ?? null;
const previewShown = () => !document.getElementById('file-preview').classList.contains('hidden');

test('the README of the top level is shown, not selected (#351)', async (t) => {
  const { dom, tree, appStore, container } = await mountTree({
    '/ws': [folder('/ws', 'docs'), file('/ws', 'AGENTS.md'), file('/ws', 'README.md')],
  });
  t.after(dom.cleanup);
  await tree.openProject('/ws');

  const readme = await tree.readableFolderReadme();
  assert.equal(readme.path, '/ws/README.md');
  assert.equal(readme.name, 'README.md');
  assert.equal(await tree.showFolderReadme(readme), true);
  await flush();
  assert.equal(previewShown(), true);
  assert.equal(shownPath(), 'README.md');
  // The user did not pick it: no row marked, nothing sent as the selection.
  assert.equal(container.querySelector('.tree-item.active'), null);
  assert.equal(appStore.selectedPath, null);
});

test('only README.md counts — not AGENTS.md, not one in a subfolder (#351)', async (t) => {
  const { dom, tree, reads } = await mountTree({
    '/ws': [folder('/ws', 'docs'), file('/ws', 'AGENTS.md'), file('/ws', 'README.txt')],
    '/ws/docs': [file('/ws/docs', 'README.md')],
  });
  t.after(dom.cleanup);
  await tree.openProject('/ws');
  assert.equal(await tree.readableFolderReadme(), null);
  assert.deepEqual(reads, [], 'nothing is read for a folder without one');
});

test('a README that cannot be shown is no README (#351)', async (t) => {
  const { dom, tree } = await mountTree(
    { '/ws': [file('/ws', 'README.md')] },
    { readFile: () => ({ error: 'too-large', size: 2 * 1024 * 1024 }) },
  );
  t.after(dom.cleanup);
  await tree.openProject('/ws');
  assert.equal(await tree.readableFolderReadme(), null);
});

test('a file already on show keeps the pane (#351)', async (t) => {
  const { dom, tree, container } = await mountTree({
    '/ws': [file('/ws', 'notes.txt'), file('/ws', 'README.md')],
  });
  t.after(dom.cleanup);
  await tree.openProject('/ws');
  const readme = await tree.readableFolderReadme();
  container.querySelector('.tree-item[data-path="/ws/notes.txt"]').click();
  await flush();
  await flush();
  assert.equal(shownPath(), 'notes.txt');
  assert.equal(await tree.showFolderReadme(readme), false);
  assert.equal(shownPath(), 'notes.txt');
});

test('a folder switched while the README was read gets none of it (#351)', async (t) => {
  let release;
  const { dom, tree } = await mountTree(
    {
      '/ws': [file('/ws', 'README.md')],
      '/other': [file('/other', 'main.js')],
    },
    { readFile: () => new Promise((resolve) => { release = () => resolve({ content: '# ws', size: 4 }); }) },
  );
  t.after(dom.cleanup);
  await tree.openProject('/ws');
  const pending = tree.readableFolderReadme();
  await flush();
  await tree.openProject('/other');
  release();
  assert.equal(await pending, null);
  // And a README of the folder left is not shown in the new one.
  assert.equal(await tree.showFolderReadme({ path: '/ws/README.md', name: 'README.md' }), false);
  assert.equal(previewShown(), false);
});
