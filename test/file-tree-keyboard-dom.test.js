// The file tree from the keyboard (#74): a WAI-ARIA tree with a roving
// tabindex. Which row is the tab stop, where the arrow keys go, what Enter,
// Shift+Enter and the context-menu keys do, and what a screen reader is told.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const ROOT = '/ws';

function fakeFilesystem() {
  return {
    '/ws': [
      { name: 'docs', path: '/ws/docs', isDirectory: true },
      { name: 'locked', path: '/ws/locked', isDirectory: true },
      { name: 'README.md', path: '/ws/README.md', isDirectory: false, size: 12, modified: 0 },
    ],
    '/ws/docs': [
      { name: 'deep', path: '/ws/docs/deep', isDirectory: true },
      { name: 'notes.md', path: '/ws/docs/notes.md', isDirectory: false, size: 5, modified: 0 },
    ],
    '/ws/docs/deep': [
      { name: 'x.md', path: '/ws/docs/deep/x.md', isDirectory: false, size: 1, modified: 0 },
    ],
  };
}

async function mountTree() {
  const dom = setupRendererDom();
  const { initFileTree } = await importRenderer('components', 'FileTree.js');
  const { appStore } = await importRenderer('state', 'store.js');
  appStore.rootPath = null;
  appStore.activeTreeItem = null;
  appStore.selectedPath = null;
  appStore.selectedIsDirectory = false;
  appStore.showHiddenFiles = false;
  appStore.currentChatId = 'chat-a';

  const entries = fakeFilesystem();
  const hidden = {};
  const listeners = { treeChanged: null };
  const menuCalls = [];
  const references = [];
  const api = {
    activateFolder: async () => ({ ok: true }),
    getFolderHistory: async () => ({ paths: [] }),
    readDirectory: async (dir) => (dir === '/ws/locked'
      ? { entries: [], hidden: 0, unreadable: 'permission' }
      : { entries: entries[dir] ?? [], hidden: hidden[dir] ?? 0 }),
    readFile: async () => ({ content: 'text', size: 4 }),
    onFsTreeChanged: (cb) => { listeners.treeChanged = cb; },
    onFsItemDeleted: () => {},
    onFsClearAgentMark: () => {},
    showFileContextMenu: async (path, options) => { menuCalls.push([path, options]); return { ok: true }; },
  };
  const tree = initFileTree({
    api,
    appStore,
    onInputChanged() {},
    onWorkspaceChanged() {},
    onProjectOpened() {},
    sendChatMessage() {},
    activeProviderConfigured: () => true,
    insertChatReference: (path, kind) => references.push([path, kind]),
  });
  await tree.openProject(ROOT);
  const settle = async () => { await flush(); await flush(); await flush(); };
  const emitTreeChanged = async (payload) => {
    listeners.treeChanged?.(payload);
    await settle();
  };
  return {
    dom, tree, appStore, entries, hidden, menuCalls, references, settle, emitTreeChanged,
    container: document.getElementById('tree-container'),
  };
}

const rowFor = (container, path) => container.querySelector(`.tree-item[data-path="${path}"]`);
const tabStops = (container) => [...container.querySelectorAll('[tabindex="0"]')].map((el) => el.dataset.path);
const focusedPath = () => document.activeElement?.dataset?.path ?? null;

function press(target, key, init = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** Presses on whatever has the focus, and lets a load it started finish. */
async function pressOnFocus(key, settle, init) {
  const event = press(document.activeElement, key, init);
  await settle();
  return event;
}

test('the tree carries its roles, and only the first row is a tab stop', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);

  assert.equal(container.getAttribute('role'), 'tree');
  assert.equal(container.getAttribute('aria-label'), 'Files');

  const docs = rowFor(container, '/ws/docs');
  assert.equal(docs.getAttribute('role'), 'treeitem');
  assert.equal(docs.getAttribute('aria-level'), '1');
  assert.equal(docs.getAttribute('aria-expanded'), 'false');
  assert.equal(docs.getAttribute('aria-selected'), 'false');
  assert.equal(docs.getAttribute('aria-label'), 'docs');
  assert.equal(container.querySelector('.tree-children[data-path="/ws/docs"]').getAttribute('role'), 'group');

  const readme = rowFor(container, '/ws/README.md');
  assert.equal(readme.hasAttribute('aria-expanded'), false, 'a file has nothing to expand');

  assert.deepEqual(tabStops(container), ['/ws/docs']);
  assert.equal(readme.tabIndex, -1);
});

test('the @ button is no stop of its own; its tooltip names Shift+Enter', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);

  const button = rowFor(container, '/ws/README.md').querySelector('.tree-item-reference');
  assert.equal(button.tabIndex, -1);
  assert.equal(button.getAttribute('aria-hidden'), 'true');
  assert.match(button.title, /\(Shift\+Enter\)$/);
});

test('up, down, Home and End walk the visible rows and carry the tab stop along', async (t) => {
  const { dom, container, settle } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/docs').focus();
  await pressOnFocus('ArrowDown', settle);
  assert.equal(focusedPath(), '/ws/locked', 'the closed folder\'s children are passed over');
  await pressOnFocus('ArrowDown', settle);
  assert.equal(focusedPath(), '/ws/README.md');
  await pressOnFocus('ArrowDown', settle);
  assert.equal(focusedPath(), '/ws/README.md', 'the last row stays the last');
  assert.deepEqual(tabStops(container), ['/ws/README.md']);

  await pressOnFocus('Home', settle);
  assert.equal(focusedPath(), '/ws/docs');
  await pressOnFocus('ArrowUp', settle);
  assert.equal(focusedPath(), '/ws/docs', 'the first row stays the first');
  await pressOnFocus('End', settle);
  assert.equal(focusedPath(), '/ws/README.md');
  assert.deepEqual(tabStops(container), ['/ws/README.md']);
});

test('right opens a folder without selecting it, then steps into it; left goes back and closes', async (t) => {
  const { dom, container, appStore, settle } = await mountTree();
  t.after(dom.cleanup);

  const docs = rowFor(container, '/ws/docs');
  docs.focus();
  await pressOnFocus('ArrowRight', settle);
  assert.equal(docs.getAttribute('aria-expanded'), 'true');
  assert.equal(container.querySelector('.tree-children[data-path="/ws/docs"]').classList.contains('expanded'), true);
  assert.equal(appStore.selectedPath, null, 'opening from the keyboard selects nothing');
  assert.equal(docs.getAttribute('aria-selected'), 'false');
  assert.equal(focusedPath(), '/ws/docs');

  await pressOnFocus('ArrowRight', settle);
  assert.equal(focusedPath(), '/ws/docs/deep');
  assert.equal(document.activeElement.getAttribute('aria-level'), '2');

  // Down walks into the open folder and out of it again.
  await pressOnFocus('ArrowDown', settle);
  assert.equal(focusedPath(), '/ws/docs/notes.md');
  await pressOnFocus('ArrowRight', settle);
  assert.equal(focusedPath(), '/ws/docs/notes.md', 'a file has nothing to the right');
  await pressOnFocus('ArrowDown', settle);
  assert.equal(focusedPath(), '/ws/locked');

  await pressOnFocus('ArrowUp', settle);
  await pressOnFocus('ArrowLeft', settle);
  assert.equal(focusedPath(), '/ws/docs', 'left on a child goes to its folder');
  await pressOnFocus('ArrowLeft', settle);
  assert.equal(docs.getAttribute('aria-expanded'), 'false');
  assert.equal(focusedPath(), '/ws/docs');
  await pressOnFocus('ArrowLeft', settle);
  assert.equal(focusedPath(), '/ws/docs', 'left on the top level stays');
});

test('Enter opens a file and selects it, and opens a folder like a click', async (t) => {
  const { dom, container, appStore, settle } = await mountTree();
  t.after(dom.cleanup);

  const readme = rowFor(container, '/ws/README.md');
  readme.focus();
  const event = await pressOnFocus('Enter', settle);
  assert.equal(event.defaultPrevented, true);
  assert.equal(appStore.selectedPath, '/ws/README.md');
  assert.equal(readme.getAttribute('aria-selected'), 'true');
  assert.ok(document.querySelector('#preview-body > .file-view'), 'the file is on show');

  const docs = rowFor(container, '/ws/docs');
  docs.focus();
  await pressOnFocus('Enter', settle);
  assert.equal(docs.getAttribute('aria-expanded'), 'true');
  assert.equal(appStore.selectedPath, '/ws/docs');
  assert.equal(docs.getAttribute('aria-selected'), 'true');
  assert.equal(readme.getAttribute('aria-selected'), 'false', 'one selection at a time');
});

test('Shift+Enter references the row in the chat; the arrows leave other modifiers alone', async (t) => {
  const { dom, container, references, settle } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').focus();
  await pressOnFocus('Enter', settle, { shiftKey: true });
  rowFor(container, '/ws/docs').focus();
  await pressOnFocus('Enter', settle, { shiftKey: true });
  assert.deepEqual(references, [['README.md', 'file'], ['docs', 'directory']]);

  const event = await pressOnFocus('ArrowDown', settle, { metaKey: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(focusedPath(), '/ws/docs');
});

test('Shift+F10 and the context-menu key open the menu below the row', async (t) => {
  const { dom, container, menuCalls, settle } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').focus();
  const event = await pressOnFocus('F10', settle, { shiftKey: true });
  assert.equal(event.defaultPrevented, true, 'Chromium would open its own menu on top');
  await pressOnFocus('ContextMenu', settle);

  assert.equal(menuCalls.length, 2);
  for (const [path, options] of menuCalls) {
    assert.equal(path, '/ws/README.md');
    assert.equal(Number.isInteger(options.position.x), true);
    assert.equal(Number.isInteger(options.position.y), true);
  }

  // A right-click opens it where the mouse is, as before.
  rowFor(container, '/ws/docs').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal('position' in menuCalls[2][1], false);
});

test('a click moves the tab stop to the row; a folder closed over it hands the stop on', async (t) => {
  const { dom, container, settle } = await mountTree();
  t.after(dom.cleanup);

  const docs = rowFor(container, '/ws/docs');
  docs.focus();
  await pressOnFocus('ArrowRight', settle);
  await pressOnFocus('ArrowRight', settle);
  assert.deepEqual(tabStops(container), ['/ws/docs/deep']);

  // The mouse folds the folder up while its child has the stop.
  document.activeElement.blur();
  docs.click();
  await settle();
  assert.deepEqual(tabStops(container), ['/ws/docs'], 'the selection takes the stop, not a hidden row');

  rowFor(container, '/ws/README.md').focus();
  assert.deepEqual(tabStops(container), ['/ws/README.md']);
});

test('a focused row deleted outside the app passes the focus on, it does not drop out of the tree', async (t) => {
  const { dom, container, entries, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').focus();
  entries['/ws'] = entries['/ws'].filter((e) => e.name !== 'README.md');
  await emitTreeChanged({ directories: ['/ws'], complete: true });

  assert.equal(rowFor(container, '/ws/README.md'), null);
  assert.equal(container.contains(document.activeElement), true);
  assert.deepEqual(tabStops(container), [focusedPath()]);
});

test('a note under a folder describes the folder row; one at the top describes the tree', async (t) => {
  const { dom, container, hidden, settle } = await mountTree();
  t.after(dom.cleanup);

  const locked = rowFor(container, '/ws/locked');
  locked.focus();
  await pressOnFocus('ArrowRight', settle);
  const note = container.querySelector('.tree-unreadable');
  assert.ok(note.id);
  assert.equal(locked.getAttribute('aria-describedby'), note.id);
  // Still no row: the arrows pass it.
  await pressOnFocus('ArrowDown', settle);
  assert.equal(focusedPath(), '/ws/README.md');

  hidden['/ws/docs'] = 3;
  const docs = rowFor(container, '/ws/docs');
  docs.focus();
  await pressOnFocus('ArrowRight', settle);
  const count = container.querySelector('.tree-children[data-path="/ws/docs"] > .tree-hidden-entries');
  assert.equal(docs.getAttribute('aria-describedby'), count.id);
  assert.equal(container.hasAttribute('aria-describedby'), false);
});

test('an agent mark is the row\'s description, and goes away with the mark', async (t) => {
  const { dom, tree, container } = await mountTree();
  t.after(dom.cleanup);

  tree.recordAgentFile('write', 'README.md', 'chat-a');
  await flush();
  const readme = rowFor(container, '/ws/README.md');
  const mark = readme.querySelector(':scope > .tree-mark');
  assert.equal(readme.getAttribute('aria-describedby'), mark.id);
  assert.equal(readme.getAttribute('aria-label'), 'README.md', 'the name stays the name');

  // The eraser takes the mark, and the description with it.
  document.getElementById('btn-tree-clear-marks').click();
  await flush();
  assert.equal(readme.querySelector(':scope > .tree-mark'), null);
  assert.equal(readme.hasAttribute('aria-describedby'), false);
});
