// The folder history menu and the recent-folder chips (#638), on the real DOM.
//
// The menu carried `role="menu"` without a menu's keyboard model: the focus
// stayed on the button, Escape dropped it to the page, Tab left the menu open
// and stopped at every row and every remove button. The chips on the welcome
// screen were buttons with `role="listitem"`, which took their button role
// away. Both now follow the model menu (#583).
//
// Nodes are compared as booleans: a failing `assert.equal` on a happy-dom node
// formats the whole DOM graph and hangs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

// One path of each kind the menu has to draw the right way round.
const POSIX = '/Users/k/snotra';
const WINDOWS = 'C:\\Users\\x\\repo';
const UNC = '\\\\server\\share\\repo';

async function setup(t, { paths = [POSIX, WINDOWS, UNC], chosenFolder = null } = {}) {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { initFileTree } = await importRenderer('components', 'FileTree.js');
  const { appStore } = await importRenderer('state', 'store.js');
  appStore.rootPath = null;
  appStore.activeTreeItem = null;
  appStore.showHiddenFiles = false;

  let history = [...paths];
  const removed = [];
  const dialogs = [];
  const tree = initFileTree({
    api: {
      activateFolder: async () => ({ ok: true }),
      openFolder: async () => {
        dialogs.push('openFolder');
        return chosenFolder;
      },
      getFolderHistory: async () => ({ paths: [...history] }),
      removeFolderFromHistory: async (p) => {
        removed.push(p);
        history = history.filter((h) => h !== p);
        return { paths: [...history] };
      },
      readDirectory: async () => ({ entries: [], hidden: 0 }),
      onFsTreeChanged: () => () => {},
      onFsItemDeleted: () => {},
    },
    appStore,
    onInputChanged() {},
    onWorkspaceChanged() {},
    onProjectOpened() {},
    sendChatMessage() {},
    activeProviderConfigured: () => true,
  });
  await flush();

  const { document } = dom;
  const button = document.getElementById('btn-workspace');
  const menu = document.getElementById('folder-history-menu');
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
  return {
    dom,
    document,
    tree,
    appStore,
    removed,
    dialogs,
    button,
    menu,
    items,
    /** Whether `el` has the focus, as a boolean (see the note at the top). */
    focused: (el) => document.activeElement === el,
    /** The index of the focused entry in the menu, -1 for none. */
    focusedIndex: () => items().indexOf(document.activeElement),
    async open() {
      button.click();
      await flush();
    },
    key(target, key) {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    },
  };
}

/** The name `aria-labelledby` gives an element: the texts it points to, one space apart. */
function labelledName(document, el) {
  return (el.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

test('opening puts the focus on the first entry, and the button names the menu', async (t) => {
  const { button, menu, focusedIndex, open } = await setup(t);
  assert.equal(menu.getAttribute('aria-labelledby'), 'btn-workspace');
  assert.equal(button.getAttribute('aria-controls'), 'folder-history-menu');
  await open();
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(focusedIndex(), 0);
});

test('the arrow keys move and wrap, Home and End jump', async (t) => {
  const { document, focusedIndex, open, key } = await setup(t);
  await open();
  key(document.activeElement, 'ArrowDown');
  assert.equal(focusedIndex(), 1);
  key(document.activeElement, 'ArrowUp');
  key(document.activeElement, 'ArrowUp');
  // The last entry is "Open folder…" at the foot (#676).
  assert.equal(focusedIndex(), 3, 'up from the first wraps to the last');
  key(document.activeElement, 'ArrowDown');
  assert.equal(focusedIndex(), 0, 'down from the last wraps to the first');
  key(document.activeElement, 'End');
  assert.equal(focusedIndex(), 3);
  key(document.activeElement, 'Home');
  assert.equal(focusedIndex(), 0);
});

test('Escape closes and gives the focus back to the button', async (t) => {
  const { document, button, menu, focused, open, key } = await setup(t);
  await open();
  key(document.activeElement, 'ArrowDown');
  const event = key(document.activeElement, 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(focused(button), true);
});

test('tabbing out of the menu closes it', async (t) => {
  const { document, button, menu, open } = await setup(t);
  await open();
  document.getElementById('chat-input').focus();
  await flush();
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('the menu is one Tab stop: the entry in focus, not the others and no remove button', async (t) => {
  const { document, menu, items, open, key } = await setup(t);
  await open();
  const tabStops = () => [...menu.querySelectorAll('[tabindex]')]
    .filter((el) => el.tabIndex === 0)
    .map((el) => items().indexOf(el));
  assert.deepEqual(tabStops(), [0]);
  key(document.activeElement, 'ArrowDown');
  assert.deepEqual(tabStops(), [1], 'the Tab stop follows the focus');
  for (const remove of menu.querySelectorAll('.folder-history-item-remove')) {
    assert.equal(remove.tabIndex, -1);
  }
});

test('an entry is named by folder and path, its remove button by its own label', async (t) => {
  const { document, items, open } = await setup(t);
  await open();
  const [first] = items();
  assert.equal(labelledName(document, first), `snotra ${POSIX}`);
  const remove = first.querySelector('.folder-history-item-remove');
  assert.equal(remove.getAttribute('aria-label'), 'Remove snotra from the history');
  // The Delete key is announced with the entry; the hint is out of sight.
  const hint = document.getElementById(first.getAttribute('aria-describedby'));
  assert.equal(hint.hidden, true);
  assert.equal(hint.closest('[role="menu"]') === null, true, 'the hint is no child of the menu');
  assert.match(hint.textContent, /Delete/);
});

test('Delete removes the focused entry and leaves the focus on its neighbour', async (t) => {
  const { document, menu, removed, focusedIndex, open, key } = await setup(t);
  await open();
  key(document.activeElement, 'ArrowDown');
  key(document.activeElement, 'Delete');
  await flush();
  assert.deepEqual(removed, [WINDOWS]);
  assert.equal(menu.classList.contains('hidden'), false, 'the menu stays open for the next one');
  assert.equal(focusedIndex(), 1);
  assert.equal(document.activeElement.dataset.path, UNC);
});

test('without a history the menu holds an entry that cannot be chosen, not a bare text', async (t) => {
  const { menu, items, focused, open, key } = await setup(t, { paths: [] });
  await open();
  const [empty, openFolder] = items();
  assert.equal(items().length, 2, 'the empty entry and "Open folder…"');
  assert.equal(openFolder.dataset.action, 'open-folder');
  // Besides the menu items only a heading nobody reads out and a separator.
  const others = [...menu.children].filter((el) => el.getAttribute('role') !== 'menuitem');
  assert.deepEqual(others.map((el) => el.getAttribute('aria-hidden') ?? el.getAttribute('role')), ['true', 'separator']);
  assert.equal(empty.getAttribute('aria-disabled'), 'true');
  assert.equal(empty.textContent, 'No recently opened folders yet.');
  assert.equal(focused(empty), true, 'the focus has somewhere to go');
  key(empty, 'Enter');
  key(empty, 'Delete');
  assert.equal(focused(empty), true);
});

test('removing the last entry keeps the focus in the menu, on the empty entry', async (t) => {
  const { document, menu, focusedIndex, open, key } = await setup(t, { paths: [POSIX] });
  await open();
  key(document.activeElement, 'Delete');
  await flush();
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(focusedIndex(), 0);
  assert.equal(document.activeElement.getAttribute('aria-disabled'), 'true');
});

test('a language switch redraws the open menu and keeps the focused entry', async (t) => {
  const { document, menu, focused, focusedIndex, open, key } = await setup(t);
  const { setLocale } = await importRenderer('i18n.js');
  await open();
  key(document.activeElement, 'ArrowDown');
  const before = document.activeElement;

  setLocale('de', { force: true });
  try {
    await flush();
    await flush();

    assert.equal(menu.classList.contains('hidden'), false, 'the redraw does not close the menu');
    assert.equal(focused(before), false, 'the entry was drawn anew');
    assert.equal(focusedIndex(), 1);
    assert.equal(document.activeElement.dataset.path, WINDOWS);
    assert.equal(
      document.activeElement.querySelector('.folder-history-item-remove').getAttribute('aria-label'),
      'repo aus dem Verlauf entfernen',
    );
  } finally {
    // Back to English while the DOM is still there: the open menus redraw.
    setLocale('en', { force: true });
    await flush();
  }
});

test('choosing an entry closes the menu and returns the focus to the button', async (t) => {
  const { document, button, menu, focused, open, key } = await setup(t);
  await open();
  key(document.activeElement, 'ArrowDown');
  key(document.activeElement, 'Enter');
  await flush();
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(focused(button), true);
});

test('a path reads left to right inside the box that cuts it at the start', async (t) => {
  const { menu, open } = await setup(t);
  await open();
  const lines = [...menu.querySelectorAll('.folder-history-path')];
  assert.deepEqual(lines.map((line) => line.textContent), [POSIX, WINDOWS, UNC]);
  for (const line of lines) {
    const isolate = line.firstElementChild;
    assert.equal(isolate?.tagName, 'BDI');
    assert.equal(isolate.getAttribute('dir'), 'ltr');
  }
});

// ── The welcome screen ───────────────────────────────────────────────────────

test('a recent-folder chip is a button inside a list item, without a role of its own', async (t) => {
  const { document, tree } = await setup(t);
  await tree.refreshWelcomeRecent();
  const list = document.getElementById('welcome-recent-list');
  assert.equal(list.getAttribute('role'), 'list');
  assert.equal(list.children.length, 3);
  for (const item of list.children) {
    assert.equal(item.getAttribute('role'), 'listitem');
    const chip = item.firstElementChild;
    assert.equal(chip?.tagName, 'BUTTON');
    assert.equal(chip.getAttribute('role'), null);
  }
  const first = list.children[0].firstElementChild;
  assert.equal(labelledName(document, first), `snotra ${POSIX}`);
  const path = first.querySelector('.chip-recent-path > bdi[dir="ltr"]');
  assert.equal(path?.textContent, POSIX);
});

// ── "Open folder…" (#676) ────────────────────────────────────────────────────

test('"Open folder…" at the foot of the menu asks for a folder and opens it', async (t) => {
  const { document, button, menu, dialogs, appStore, focused, open, key } = await setup(t, { chosenFolder: '/Users/k/other' });
  await open();
  key(document.activeElement, 'End');
  const entry = document.activeElement;
  assert.equal(entry.dataset.action, 'open-folder');
  assert.equal(entry.textContent, 'Open folder…');
  key(entry, 'Enter');
  await flush();
  await flush();
  assert.deepEqual(dialogs, ['openFolder']);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(appStore.rootPath, '/Users/k/other');
  assert.equal(focused(button), true, 'the focus went back to the switcher before the dialog');
});

test('"Open folder…" cannot be removed with Delete, and a cancelled dialog opens nothing', async (t) => {
  const { document, removed, dialogs, appStore, open, key } = await setup(t);
  await open();
  key(document.activeElement, 'End');
  key(document.activeElement, 'Delete');
  await flush();
  assert.deepEqual(removed, []);
  document.activeElement.click();
  await flush();
  assert.deepEqual(dialogs, ['openFolder']);
  assert.equal(appStore.rootPath, null);
});
