// The open workspace in title bar, tree header and window title, and the
// header's `⋯` menu (#676), on the real DOM.
//
// Until #676 the folder's name shared a line with seven buttons and kept ten
// characters of itself, the path was a tooltip only, and with the sidebar
// hidden no folder was named anywhere.
//
// happy-dom has no layout: the cut in the middle is checked on a stand-in
// whose width follows the text (see `middleCut` and `fitMiddle` below), the
// header itself keeps the names whole.
//
// Nodes are compared as booleans: a failing `assert.equal` on a happy-dom node
// formats the whole DOM graph and hangs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const ROOT = '/Users/k/Projects/snotra-promotion';

async function setup(t, { homeDir = '/Users/k' } = {}) {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { initFileTree } = await importRenderer('components', 'FileTree.js');
  const { initWorkspaceHeader } = await importRenderer('components', 'WorkspaceHeader.js');
  const { appStore } = await importRenderer('state', 'store.js');
  appStore.rootPath = null;
  appStore.activeTreeItem = null;
  appStore.showHiddenFiles = false;

  let home = homeDir;
  const homeListeners = [];
  const tree = initFileTree({
    api: {
      activateFolder: async () => ({ ok: true }),
      getFolderHistory: async () => ({ paths: [ROOT] }),
      readDirectory: async () => ({ entries: [], hidden: 0 }),
      onFsTreeChanged: () => () => {},
      onFsItemDeleted: () => {},
      setUIPrefs: async () => {},
    },
    appStore,
    onInputChanged() {},
    onWorkspaceChanged() {},
    onProjectOpened() {},
    sendChatMessage() {},
    activeProviderConfigured: () => true,
    workspaceHeader: initWorkspaceHeader({
      getHomeDir: () => home,
      subscribeHomeDir: (listener) => homeListeners.push(listener),
    }),
  });
  await flush();

  const { document } = dom;
  const byId = (id) => document.getElementById(id);
  return {
    dom,
    document,
    tree,
    byId,
    async openFolder(folder = ROOT) {
      await tree.openProject(folder);
      for (let i = 0; i < 4; i += 1) await flush();
    },
    /** The home folder arrives later, with the tool permissions. */
    setHome(value) {
      home = value;
      for (const listener of homeListeners) listener();
    },
    key(target, key) {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    },
  };
}

// ── Title bar and window title ───────────────────────────────────────────────

test('without a folder the title bar shows the brand alone, and the switcher says so', async (t) => {
  const { document, byId } = await setup(t);
  assert.equal(byId('titlebar-workspace').hidden, true);
  assert.equal(byId('titlebar').classList.contains('titlebar--workspace'), false);
  assert.equal(document.title, 'Snotra Agent');
  assert.equal(byId('project-name').textContent, 'No folder open');
  assert.equal(byId('project-path').hidden, true);
  assert.equal(byId('btn-workspace').getAttribute('aria-label'), 'No folder open. Open a folder');
  assert.equal(byId('btn-tree-actions').hidden, true, 'nothing to filter or create in yet');
});

test('an open folder is named first in the title bar, with the brand after it, and in the window title', async (t) => {
  const { document, byId, openFolder } = await setup(t);
  await openFolder();
  assert.equal(byId('titlebar-workspace').hidden, false);
  assert.equal(byId('titlebar-workspace-name').textContent, 'snotra-promotion');
  assert.equal(byId('titlebar-workspace').title, ROOT);
  assert.equal(byId('titlebar').classList.contains('titlebar--workspace'), true, 'the brand steps back');
  assert.equal(document.title, 'snotra-promotion — Snotra Agent');
});

// ── The switcher ─────────────────────────────────────────────────────────────

test('the switcher carries name and path, both in its label for the keyboard', async (t) => {
  const { byId, openFolder } = await setup(t);
  await openFolder();
  const button = byId('btn-workspace');
  assert.equal(byId('project-name').textContent, 'snotra-promotion');
  for (const id of ['project-path', 'project-path-narrow']) {
    assert.equal(byId(id).hidden, false);
    assert.equal(byId(id).textContent, '~/Projects/snotra-promotion', `${id} abbreviates the home folder`);
    assert.equal(byId(id).getAttribute('aria-hidden'), 'true', `${id} is read from the label`);
  }
  assert.equal(button.getAttribute('aria-label'), 'snotra-promotion, ~/Projects/snotra-promotion. Switch folder');
  assert.equal(button.title, `Switch folder · ${ROOT}`);
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(button.getAttribute('aria-controls'), 'folder-history-menu');
});

test('a home folder that arrives after the folder still shortens the path', async (t) => {
  const { byId, openFolder, setHome } = await setup(t, { homeDir: '' });
  await openFolder();
  assert.equal(byId('project-path').textContent, ROOT);
  setHome('/Users/k');
  assert.equal(byId('project-path').textContent, '~/Projects/snotra-promotion');
});

test('a language switch relabels the switcher and keeps the folder\'s name', async (t) => {
  const { byId, openFolder } = await setup(t);
  const { setLocale } = await importRenderer('i18n.js');
  await openFolder();
  setLocale('de', { force: true });
  try {
    await flush();
    assert.equal(byId('project-name').textContent, 'snotra-promotion');
    assert.equal(byId('btn-workspace').getAttribute('aria-label'), 'snotra-promotion, ~/Projects/snotra-promotion. Ordner wechseln');
  } finally {
    setLocale('en', { force: true });
    await flush();
  }
});

// ── The `⋯` menu ─────────────────────────────────────────────────────────────

test('the `⋯` menu opens on its first entry, and the arrows move and wrap', async (t) => {
  const { document, byId, openFolder, key } = await setup(t);
  await openFolder();
  const button = byId('btn-tree-actions');
  const menu = byId('tree-actions-menu');
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute('aria-label'), 'More actions');
  assert.equal(menu.getAttribute('aria-labelledby'), 'btn-tree-actions');

  button.click();
  const items = [...menu.querySelectorAll('[role^="menuitem"]')];
  const index = () => items.indexOf(document.activeElement);
  assert.deepEqual(items.map((el) => el.dataset.action), ['filter', 'new-file', 'new-folder', 'hidden-files']);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(index(), 0);
  assert.deepEqual(items.map((el) => el.tabIndex), [0, -1, -1, -1], 'one Tab stop');

  key(document.activeElement, 'ArrowUp');
  assert.equal(index(), 3, 'up from the first wraps to the last');
  key(document.activeElement, 'ArrowDown');
  assert.equal(index(), 0);
  key(document.activeElement, 'End');
  assert.equal(index(), 3);
  key(document.activeElement, 'Home');
  assert.equal(index(), 0);
});

test('Escape closes the `⋯` menu and gives the focus back; tabbing out closes it too', async (t) => {
  const { document, byId, openFolder, key } = await setup(t);
  await openFolder();
  const button = byId('btn-tree-actions');
  const menu = byId('tree-actions-menu');

  button.click();
  const event = key(document.activeElement, 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement === button, true);

  button.click();
  byId('chat-input').focus();
  await flush();
  assert.equal(menu.classList.contains('hidden'), true);
});

test('the eraser stays outside the menu, next to it, while there are marks', async (t) => {
  const { byId, openFolder } = await setup(t);
  await openFolder();
  const eraser = byId('btn-tree-clear-marks');
  assert.equal(eraser.closest('#tree-actions-menu') === null, true);
  assert.equal(eraser.parentElement === byId('tree-actions-wrapper').parentElement, true, 'in the same row');
});

// ── Cutting in the middle ────────────────────────────────────────────────────

test('middleCut keeps both ends around one ellipsis', async () => {
  const { middleCut } = await importRenderer('utils', 'middleEllipsis.js');
  assert.equal(middleCut('snotra-promotion', 16), 'snotra-promotion');
  assert.equal(middleCut('snotra-promotion', 10), 'snotr…otion');
  assert.equal(middleCut('snotra-promotion', 1), 's…');
  assert.equal(middleCut('snotra-promotion', 0), '…');
});

test('fitMiddle cuts as little as the box needs, and nothing without a layout', async () => {
  const { fitMiddle } = await importRenderer('utils', 'middleEllipsis.js');
  // A stand-in for a clipping box: 7 px per character, `width` px wide.
  const box = (width) => ({
    textContent: '',
    get clientWidth() { return width; },
    get scrollWidth() { return this.textContent.length * 7; },
  });

  const wide = box(200);
  assert.equal(fitMiddle(wide, 'snotra-promotion'), false);
  assert.equal(wide.textContent, 'snotra-promotion');

  const narrow = box(70);
  assert.equal(fitMiddle(narrow, 'snotra-promotion'), true);
  assert.equal(narrow.textContent, 'snotr…tion');
  assert.ok(narrow.scrollWidth <= 70);
  assert.notEqual(
    narrow.textContent,
    (() => { const other = box(70); fitMiddle(other, 'snotra-website'); return other.textContent; })(),
    'two folders of one family stay apart',
  );

  const unlaid = box(0);
  assert.equal(fitMiddle(unlaid, 'snotra-promotion'), false);
  assert.equal(unlaid.textContent, 'snotra-promotion');
});
