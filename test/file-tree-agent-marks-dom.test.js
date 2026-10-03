// What the agent read or changed, drawn in the tree (#347). The state logic
// is in test/agent-marks.test.js; here it is about the rows: which letter,
// which words, where it goes, and when it goes away.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const ROOT = '/ws';

function fakeFilesystem() {
  return {
    '/ws': [
      { name: 'docs', path: '/ws/docs', isDirectory: true },
      { name: 'README.md', path: '/ws/README.md', isDirectory: false, size: 12, modified: 0 },
      { name: '.env', path: '/ws/.env', isDirectory: false, size: 1, modified: 0 },
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
  const listeners = { treeChanged: null, clearMark: null, deleted: null, showChanges: null };
  const changeRequests = [];
  const menuCalls = [];
  const api = {
    activateFolder: async () => ({ ok: true }),
    getFolderHistory: async () => ({ paths: [] }),
    readDirectory: async (dir, { showHidden } = {}) => ({
      entries: (entries[dir] ?? []).filter((e) => showHidden || !e.name.startsWith('.')),
      hidden: 0,
    }),
    readFile: async () => ({ content: 'text', size: 4 }),
    onFsTreeChanged: (cb) => { listeners.treeChanged = cb; },
    onFsItemDeleted: (cb) => { listeners.deleted = cb; },
    onFsClearAgentMark: (cb) => { listeners.clearMark = cb; },
    onFsShowChanges: (cb) => { listeners.showChanges = cb; },
    getFileChanges: async (ids) => {
      changeRequests.push(ids);
      return { ok: true, status: 'unchanged' };
    },
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
  });
  await tree.openProject(ROOT);
  const settle = async () => { await flush(); await flush(); };
  return {
    dom, tree, appStore, entries, listeners, menuCalls, changeRequests, settle, container: document.getElementById('tree-container'),
  };
}

const rowFor = (container, path) => container.querySelector(`.tree-item[data-path="${path}"]`);
const markOf = (container, path) => rowFor(container, path)?.querySelector(':scope > .tree-mark') ?? null;

test('no marks: no letters, and the clear button stays hidden', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);
  assert.equal(container.querySelectorAll('.tree-mark').length, 0);
  assert.equal(document.getElementById('btn-tree-clear-marks').hidden, true);
});

test('a write draws a filled M with words for the screen reader, before the @ slot', async (t) => {
  const { dom, tree, container } = await mountTree();
  t.after(dom.cleanup);
  tree.recordAgentFile('write', 'README.md', 'chat-a');
  await flush();

  const mark = markOf(container, '/ws/README.md');
  assert.ok(mark, 'the row carries a mark');
  assert.equal(mark.textContent, 'M');
  assert.equal(mark.dataset.mark, 'unseen');
  assert.equal(mark.getAttribute('role'), 'img');
  assert.equal(mark.getAttribute('aria-label'), 'Changed by the agent, not looked at yet');
  assert.equal(mark.title, mark.getAttribute('aria-label'));
  assert.ok(mark.nextElementSibling === null || mark.nextElementSibling.classList.contains('tree-item-reference'));
  assert.equal(document.getElementById('btn-tree-clear-marks').hidden, false);
});

test('a read draws a quiet R; opening the changed file in the preview outlines its M', async (t) => {
  const { dom, tree, container, settle } = await mountTree();
  t.after(dom.cleanup);
  tree.recordAgentFile('read', 'README.md', 'chat-a');
  await flush();
  assert.equal(markOf(container, '/ws/README.md').textContent, 'R');
  assert.equal(markOf(container, '/ws/README.md').getAttribute('aria-label'), 'Read by the agent');

  tree.recordAgentFile('write', 'README.md', 'chat-a');
  await flush();
  rowFor(container, '/ws/README.md').click();
  await settle();
  const mark = markOf(container, '/ws/README.md');
  assert.equal(mark.dataset.mark, 'changed');
  assert.equal(mark.getAttribute('aria-label'), 'Changed by the agent');
});

test('a change deep inside a closed folder shows on the folder, and on each level as it opens', async (t) => {
  const { dom, tree, container, settle } = await mountTree();
  t.after(dom.cleanup);
  tree.recordAgentFile('write', 'docs/deep/x.md', 'chat-a');
  await flush();

  const folderMark = markOf(container, '/ws/docs');
  assert.ok(folderMark, 'the closed folder sums up what is below');
  assert.ok(folderMark.classList.contains('tree-mark--folder'));
  assert.equal(
    folderMark.getAttribute('aria-label'),
    'Contains files the agent changed that you have not looked at yet'
  );

  rowFor(container, '/ws/docs').click();
  await settle();
  // Open, the stylesheet hides the folder's own summary; the next level carries it.
  assert.ok(markOf(container, '/ws/docs/deep'), 'the subfolder, still closed, carries it');
  rowFor(container, '/ws/docs/deep').click();
  await settle();
  assert.equal(markOf(container, '/ws/docs/deep/x.md').dataset.mark, 'unseen');
});

test('the marks follow the conversation on screen', async (t) => {
  const { dom, tree, appStore, container } = await mountTree();
  t.after(dom.cleanup);
  tree.recordAgentFile('write', 'README.md', 'chat-b');
  await flush();
  assert.equal(markOf(container, '/ws/README.md'), null, 'a run of another chat marks that chat');

  appStore.currentChatId = 'chat-b';
  tree.syncAgentMarks();
  assert.ok(markOf(container, '/ws/README.md'));

  appStore.currentChatId = 'chat-new';
  tree.syncAgentMarks();
  assert.equal(container.querySelectorAll('.tree-mark').length, 0, 'a new chat starts without marks');
  assert.equal(document.getElementById('btn-tree-clear-marks').hidden, true);
});

test('the header button clears all marks of the chat; the context menu clears one', async (t) => {
  const { dom, tree, container, listeners, menuCalls } = await mountTree();
  t.after(dom.cleanup);
  tree.recordAgentFile('write', 'README.md', 'chat-a');
  tree.recordAgentFile('read', 'docs/notes.md', 'chat-a');
  await flush();

  rowFor(container, '/ws/README.md').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  await flush();
  assert.deepEqual(menuCalls.at(-1), ['/ws/README.md', { agentMark: true, changes: false }]);
  listeners.clearMark({ path: '/ws/README.md' });
  await flush();
  assert.equal(markOf(container, '/ws/README.md'), null);
  assert.ok(markOf(container, '/ws/docs'), 'the other mark stays');

  rowFor(container, '/ws/README.md').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  await flush();
  assert.deepEqual(menuCalls.at(-1), ['/ws/README.md', { agentMark: false, changes: false }], 'no mark, no menu item');

  document.getElementById('btn-tree-clear-marks').click();
  await flush();
  assert.equal(container.querySelectorAll('.tree-mark').length, 0);
  assert.equal(document.getElementById('btn-tree-clear-marks').hidden, true);
});

test('a deleted or renamed file loses its mark; a hidden file switched off keeps it', async (t) => {
  const { dom, tree, container, entries, listeners, settle } = await mountTree();
  t.after(dom.cleanup);
  tree.recordAgentFile('write', 'README.md', 'chat-a');
  tree.recordAgentFile('read', '.env', 'chat-a');
  tree.recordAgentFile('read', 'docs/notes.md', 'chat-a');
  await flush();

  // Renamed from outside: the watcher's redraw lists the folder without it.
  entries['/ws'] = entries['/ws'].map((e) =>
    e.name === 'README.md' ? { ...e, name: 'README2.md', path: '/ws/README2.md' } : e
  );
  listeners.treeChanged({ directories: ['/ws'], complete: true });
  await settle();
  assert.equal(markOf(container, '/ws/README2.md'), null);
  assert.equal(document.getElementById('btn-tree-clear-marks').hidden, false, '.env and notes.md stay marked');

  // Deleted through the context menu: the folder's summary goes with it.
  listeners.deleted({ path: '/ws/docs/notes.md' });
  await settle();
  assert.equal(markOf(container, '/ws/docs'), null);

  // .env was never drawn (hidden files off) but is still marked: show them.
  await tree.setShowHiddenFiles(true);
  assert.equal(markOf(container, '/ws/.env').textContent, 'R');
});

test('a folder switch clears every mark', async (t) => {
  const { dom, tree, container } = await mountTree();
  t.after(dom.cleanup);
  tree.recordAgentFile('write', 'README.md', 'chat-a');
  await flush();
  await tree.openProject(ROOT);
  assert.equal(container.querySelectorAll('.tree-mark').length, 0);
});

test('hundreds of marks draw on every row without trouble', async (t) => {
  const { dom, tree, entries, container, settle, listeners } = await mountTree();
  t.after(dom.cleanup);
  entries['/ws'] = Array.from({ length: 400 }, (_, i) => ({
    name: `f${i}.js`, path: `/ws/f${i}.js`, isDirectory: false, size: 1, modified: 0,
  }));
  listeners.treeChanged({ directories: ['/ws'], complete: true });
  await settle();
  for (let i = 0; i < 400; i += 1) tree.recordAgentFile(i % 2 ? 'read' : 'write', `f${i}.js`, 'chat-a');
  await flush();
  assert.equal(container.querySelectorAll('.tree-mark').length, 400);
  assert.equal(container.querySelectorAll('.tree-mark[data-mark="unseen"]').length, 200);
});

test('a file the chat changed offers "Show changes", which opens every change of the chat (#348)', async (t) => {
  const { dom, tree, container, listeners, menuCalls, changeRequests, settle } = await mountTree();
  t.after(dom.cleanup);
  const change = (id) => ({ id, relativePath: 'README.md', status: 'text', added: 1, removed: 0 });
  tree.recordAgentFile('write', 'README.md', 'chat-a', change('ab-1'));
  tree.recordAgentFile('write', 'README.md', 'chat-a', change('ab-2'));
  tree.recordAgentFile('write', 'README.md', 'chat-b', change('ab-3'));
  tree.recordAgentFile('read', 'docs/notes.md', 'chat-a');
  await flush();

  rowFor(container, '/ws/README.md').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  await flush();
  assert.deepEqual(menuCalls.at(-1), ['/ws/README.md', { agentMark: true, changes: true }]);

  listeners.showChanges({ path: '/ws/README.md' });
  await settle();
  assert.deepEqual(changeRequests.at(-1), ['ab-1', 'ab-2'], 'the changes of the chat on screen, oldest first');
  assert.ok(rowFor(container, '/ws/README.md').classList.contains('active'), 'its row is selected');
  assert.equal(markOf(container, '/ws/README.md').dataset.mark, 'changed', 'looking at the diff counts as seen');

  // From under a message: only that message's changes.
  await tree.showFileChanges({ relativePath: 'README.md', changes: [change('ab-2')] });
  await settle();
  assert.deepEqual(changeRequests.at(-1), ['ab-2']);
});
