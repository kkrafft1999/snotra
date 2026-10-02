// An image of the open Markdown file that lies in another folder (#640): the
// watcher reports that folder, not the document's, and the tree hands the
// report to the view instead of dropping it. The view compares size and date
// from a listing first and reads the bytes only when they changed.
//
// The real tree, host and view against the real markup; `marked` is real,
// DOMPurify a pass-through stand-in (see test/markdown-document.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_OTHER = `${PNG_1PX.slice(0, -4)}AAA=`;
const README = '# Readme\n\n![Diagram](docs/img/diagram.png)\n';

async function settle() {
  for (let i = 0; i < 6; i += 1) await flush();
}

async function mountTreeWithReadme(t) {
  const dom = setupRendererDom();
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };
  const { initFileTree } = await importRenderer('components', 'FileTree.js');
  const { appStore } = await importRenderer('state', 'store.js');
  appStore.rootPath = null;
  appStore.activeTreeItem = null;
  appStore.selectedPath = null;
  appStore.selectedIsDirectory = false;
  appStore.showHiddenFiles = false;

  const disk = {
    image: { ok: true, mime: 'image/png', base64: PNG_1PX, size: 70, mtimeMs: 1 },
    listings: {
      '/ws': [
        { name: 'docs', path: '/ws/docs', isDirectory: true },
        { name: 'README.md', path: '/ws/README.md', isDirectory: false, size: README.length, modified: 1 },
      ],
      '/ws/docs/img': [{ name: 'diagram.png', path: '/ws/docs/img/diagram.png', isDirectory: false, size: 70, modified: 1 }],
    },
  };
  const calls = { images: 0 };
  let treeChanged = null;
  const api = {
    activateFolder: async () => ({ ok: true }),
    getFolderHistory: async () => ({ paths: [] }),
    readDirectory: async (dir) => ({ entries: disk.listings[dir] ?? [], hidden: 0 }),
    readFile: async () => ({ content: README, size: README.length, modified: 1 }),
    readWorkspaceImage: async () => {
      calls.images += 1;
      return disk.image;
    },
    onFsTreeChanged: (callback) => {
      treeChanged = callback;
      return () => { treeChanged = null; };
    },
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
  t.after(() => {
    delete globalThis.DOMPurify;
    dom.cleanup();
  });
  await tree.openProject('/ws');
  document.querySelector('#tree-container .tree-item[data-path="/ws/README.md"]').click();
  await settle();
  return {
    disk,
    calls,
    report: async (payload) => {
      treeChanged?.(payload);
      await settle();
    },
  };
}

const imageSrc = () => document.querySelector('.md-doc img.md-image')?.getAttribute('src') ?? null;

test('an image in another folder shows its new content when the watcher reports that folder', async (t) => {
  const { disk, calls, report } = await mountTreeWithReadme(t);
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_1PX}`);
  assert.equal(calls.images, 1);

  // Something else changed in the image's folder: listed, not read.
  await report({ directories: ['/ws/docs/img'], complete: true });
  assert.equal(calls.images, 1);

  disk.image = { ...disk.image, base64: PNG_OTHER, mtimeMs: 2 };
  disk.listings['/ws/docs/img'] = [{ ...disk.listings['/ws/docs/img'][0], modified: 2 }];
  await report({ directories: ['/ws/docs/img'], complete: true });
  assert.equal(calls.images, 2);
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_OTHER}`);
});

test('a report for a folder the document shows nothing from reads nothing', async (t) => {
  const { calls, report } = await mountTreeWithReadme(t);
  await report({ directories: ['/ws/elsewhere'], complete: true });
  assert.equal(calls.images, 1);
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_1PX}`);
});
