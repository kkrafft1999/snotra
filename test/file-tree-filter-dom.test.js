// The tree's filter (#350): a field above the tree, a flat list of matches in
// its place. Same path list and same ranking as the `@` menu; Enter opens,
// Escape closes and gives the focus back; the tree underneath stays as it was;
// a watcher report while it is open shows in the list.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const ROOT = '/ws';

function fakeFilesystem() {
  return {
    '/ws': [
      { name: 'docs', path: '/ws/docs', isDirectory: true },
      { name: 'src', path: '/ws/src', isDirectory: true },
      { name: 'README.md', path: '/ws/README.md', isDirectory: false, size: 12, modified: 0 },
    ],
    '/ws/docs': [
      { name: 'deep', path: '/ws/docs/deep', isDirectory: true },
      { name: 'notes.md', path: '/ws/docs/notes.md', isDirectory: false, size: 5, modified: 0 },
    ],
    '/ws/docs/deep': [
      { name: 'readme-deep.md', path: '/ws/docs/deep/readme-deep.md', isDirectory: false, size: 1, modified: 0 },
    ],
    '/ws/src': [
      { name: 'main.js', path: '/ws/src/main.js', isDirectory: false, size: 1, modified: 0 },
    ],
  };
}

const PATHS = [
  { path: 'docs', kind: 'directory' },
  { path: 'src', kind: 'directory' },
  { path: 'README.md', kind: 'file' },
  { path: 'docs/deep', kind: 'directory' },
  { path: 'docs/notes.md', kind: 'file' },
  { path: 'src/main.js', kind: 'file' },
  { path: 'docs/deep/readme-deep.md', kind: 'file' },
];

async function mountTree({ paths = PATHS, truncated = false } = {}) {
  const dom = setupRendererDom();
  const { initFileTree } = await importRenderer('components', 'FileTree.js');
  const { initMentionAutocomplete } = await importRenderer('components', 'MentionAutocomplete.js');
  const { createWorkspacePathSource } = await importRenderer('tree', 'workspacePaths.js');
  const { appStore } = await importRenderer('state', 'store.js');
  appStore.rootPath = null;
  appStore.activeTreeItem = null;
  appStore.selectedPath = null;
  appStore.selectedIsDirectory = false;
  appStore.showHiddenFiles = false;
  appStore.currentChatId = 'chat-a';

  const listing = { entries: paths, truncated };
  const listeners = { treeChanged: null };
  const reads = [];
  const pathCalls = [];
  const api = {
    activateFolder: async () => ({ ok: true }),
    getFolderHistory: async () => ({ paths: [] }),
    readDirectory: async (dir) => ({ entries: fakeFilesystem()[dir] ?? [], hidden: 0 }),
    readFile: async (p) => { reads.push(p); return { content: 'text', size: 4 }; },
    listWorkspacePaths: async (options) => {
      pathCalls.push(options);
      return { entries: listing.entries.slice(), truncated: listing.truncated };
    },
    setUIPrefs: async () => ({ ok: true }),
    onFsTreeChanged: (cb) => { listeners.treeChanged = cb; },
    onFsItemDeleted: () => {},
    onFsClearAgentMark: () => {},
    showFileContextMenu: async () => ({ ok: true }),
  };
  const workspacePaths = createWorkspacePathSource({ api, appStore });
  const mention = initMentionAutocomplete({ api, appStore, onInputChanged() {}, paths: workspacePaths });
  const tree = initFileTree({
    api,
    appStore,
    onInputChanged() {},
    onWorkspaceChanged() {},
    onProjectOpened() {},
    sendChatMessage() {},
    activeProviderConfigured: () => true,
    insertChatReference() {},
    workspacePaths,
  });
  await tree.openProject(ROOT);
  const settle = async () => { for (let i = 0; i < 6; i += 1) await flush(); };
  await settle();
  return {
    dom, tree, mention, appStore, listing, listeners, reads, pathCalls, settle,
    container: document.getElementById('tree-container'),
    bar: document.getElementById('tree-filter'),
    input: document.getElementById('tree-filter-input'),
    results: document.getElementById('tree-filter-results'),
    status: document.getElementById('tree-filter-status'),
    button: document.getElementById('btn-tree-filter'),
  };
}

const rowFor = (container, path) => container.querySelector(`.tree-item[data-path="${path}"]`);
const shownPaths = (results) => [...results.querySelectorAll('.tree-filter-option')].map((el) => el.dataset.path);
const selectedPath = (results) => results.querySelector('.tree-filter-option[aria-selected="true"]')?.dataset.path ?? null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function press(target, key, init = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

async function typeQuery(input, text, settle) {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

test('the magnifier is there once a folder is open, and opens the field', async (t) => {
  const { dom, button, bar, input, settle } = await mountTree();
  t.after(dom.cleanup);

  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.match(button.title, /^Filter files \((⌘P|Ctrl\+P)\)$/);
  assert.equal(bar.hidden, true);

  button.focus();
  button.click();
  await settle();
  assert.equal(bar.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, input);
  assert.equal(input.getAttribute('role'), 'combobox');
});

test('the filter finds the same files as @ for the same query, in the same order', async (t) => {
  const { dom, tree, results, input, settle } = await mountTree();
  t.after(dom.cleanup);
  const { rankMentionCandidates } = await importRenderer('chat', 'mentionAutocomplete.js');

  tree.openFilter();
  for (const query of ['read', 'md', 'docs', 'dp']) {
    await typeQuery(input, query, settle);
    const expected = rankMentionCandidates(PATHS, query).map((entry) => entry.path);
    assert.deepEqual(shownPaths(results), expected, query);
  }

  // And the @ menu, typed into the chat input, lists the same paths first.
  await typeQuery(input, 'md', settle);
  const fromFilter = shownPaths(results);
  const chatInput = document.getElementById('chat-input');
  chatInput.focus();
  chatInput.value = '@md';
  chatInput.setSelectionRange(3, 3);
  chatInput.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const menuTexts = [...document.querySelectorAll('.chat-mention-option')].map((el) => el.textContent);
  const filterTexts = fromFilter.map((p) => {
    const slash = p.lastIndexOf('/');
    return slash >= 0 ? `${p.slice(slash + 1)}${p.slice(0, slash + 1)}` : p;
  });
  assert.deepEqual(menuTexts, filterTexts.slice(0, 8));
});

test('a query puts the list in the tree\'s place, highlighted; the tree stays as it was', async (t) => {
  const { dom, tree, container, results, status, input, settle } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/docs').click();
  await settle();
  const before = container.innerHTML;

  tree.openFilter();
  await settle();
  assert.equal(results.hidden, true, 'an empty field leaves the tree on screen');
  assert.equal(container.hidden, false);

  await typeQuery(input, 'read', settle);
  assert.equal(results.hidden, false);
  assert.equal(container.hidden, true);
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(shownPaths(results), ['README.md', 'docs/deep/readme-deep.md']);

  const first = results.querySelector('.tree-filter-option');
  assert.equal(first.getAttribute('role'), 'option');
  assert.equal(first.querySelector('.tree-filter-name mark').textContent, 'READ');
  const second = results.querySelectorAll('.tree-filter-option')[1];
  assert.equal(second.querySelector('.tree-filter-dir').textContent, 'docs/deep');
  assert.equal(second.getAttribute('aria-label'), 'readme-deep.md, docs/deep');
  assert.equal(status.textContent, '2 matches');
  assert.equal(status.getAttribute('role'), 'status');

  press(input, 'Escape');
  await settle();
  assert.equal(container.hidden, false);
  assert.equal(results.hidden, true);
  assert.equal(container.innerHTML, before, 'open folders and selection untouched');
});

test('the arrows move the selection; aria-activedescendant follows', async (t) => {
  const { dom, tree, results, input, settle } = await mountTree();
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'md', settle);
  const all = shownPaths(results);
  assert.equal(selectedPath(results), all[0]);
  assert.equal(input.getAttribute('aria-activedescendant'), 'tree-filter-option-0');

  press(input, 'ArrowDown');
  assert.equal(selectedPath(results), all[1]);
  assert.equal(input.getAttribute('aria-activedescendant'), 'tree-filter-option-1');
  press(input, 'PageDown');
  assert.equal(selectedPath(results), all.at(-1), 'the last stays the last');
  press(input, 'ArrowUp');
  assert.equal(selectedPath(results), all.at(-2));
  press(input, 'PageUp');
  assert.equal(selectedPath(results), all[0]);
});

test('Enter opens the selected file, reveals it in the tree, and the list stays', async (t) => {
  const { dom, tree, appStore, container, results, input, reads, settle } = await mountTree();
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'read', settle);
  press(input, 'ArrowDown');
  press(input, 'Enter');
  await settle();

  assert.deepEqual(reads.filter((p) => p.endsWith('readme-deep.md')).length > 0, true);
  assert.equal(appStore.selectedPath, '/ws/docs/deep/readme-deep.md');
  assert.equal(results.hidden, false, 'the list stays for the next one');
  assert.equal(document.activeElement, input);

  // Escape: the tree is back, unfolded to the file, and the focus is on it.
  press(input, 'Escape');
  await settle();
  const row = rowFor(container, '/ws/docs/deep/readme-deep.md');
  assert.ok(row);
  assert.equal(row.classList.contains('active'), true);
  assert.equal(document.activeElement, row);
});

test('Enter on a folder closes the filter and shows the folder in the tree', async (t) => {
  const { dom, tree, appStore, container, bar, input, settle } = await mountTree();
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'deep', settle);
  // docs/deep (name starts with) ranks before readme-deep.md (name contains).
  press(input, 'Enter');
  await settle();

  assert.equal(bar.hidden, true);
  assert.equal(appStore.selectedPath, '/ws/docs/deep');
  const row = rowFor(container, '/ws/docs/deep');
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, row);
});

test('a click opens a match without taking the focus from the field', async (t) => {
  const { dom, tree, appStore, results, input, settle } = await mountTree();
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'main', settle);
  const option = results.querySelector('.tree-filter-option[data-path="src/main.js"]');
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  option.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  option.click();
  await settle();
  assert.equal(appStore.selectedPath, '/ws/src/main.js');
  assert.equal(document.activeElement, input);
});

test('typing into the focused tree starts the filter with that letter; Escape returns to the row', async (t) => {
  const { dom, container, bar, input, settle } = await mountTree();
  t.after(dom.cleanup);

  const row = rowFor(container, '/ws/src');
  row.focus();
  const event = press(row, 'n');
  await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(bar.hidden, false);
  assert.equal(input.value, 'n');
  assert.equal(document.activeElement, input);

  // Space is no query, and the modifiers stay with their shortcuts.
  press(input, 'Escape');
  await settle();
  assert.equal(bar.hidden, true);
  assert.equal(document.activeElement, row);
  press(row, ' ');
  press(row, 'p', { metaKey: true });
  await settle();
  assert.equal(bar.hidden, true);
});

test('Escape gives the focus back to where Cmd/Ctrl+P took it from', async (t) => {
  const { dom, tree, input, settle } = await mountTree();
  t.after(dom.cleanup);

  const chatInput = document.getElementById('chat-input');
  chatInput.focus();
  tree.openFilter();
  await typeQuery(input, 'md', settle);
  assert.equal(document.activeElement, input);
  press(input, 'Escape');
  await settle();
  assert.equal(document.activeElement, chatInput);
});

test('a second open takes the field again, its query selected', async (t) => {
  const { dom, tree, input, settle } = await mountTree();
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'docs', settle);
  document.getElementById('chat-input').focus();
  tree.openFilter();
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 4);
});

test('no match says so, with the query', async (t) => {
  const { dom, tree, results, status, input, settle } = await mountTree();
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'zzz', settle);
  assert.deepEqual(shownPaths(results), []);
  assert.equal(results.querySelector('.tree-filter-message').textContent, 'No file or folder matches “zzz”.');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(input.hasAttribute('aria-activedescendant'), false);
  assert.equal(status.hidden, true);
});

test('thousands of matches: two hundred are drawn, the count says how many there are', async (t) => {
  const many = Array.from({ length: 3000 }, (_, i) => ({ path: `gen/file-${String(i).padStart(4, '0')}.txt`, kind: 'file' }));
  const { dom, tree, results, status, input, settle } = await mountTree({ paths: many, truncated: true });
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'file', settle);
  assert.equal(shownPaths(results).length, 200);
  assert.equal(
    status.textContent,
    'First 200 of 3,000 matches — type more to narrow them down. Only the first 3,000 entries of this folder are searched.'
  );
});

test('a watcher report while the filter is open shows in the list, the selection kept', async (t) => {
  const { dom, tree, results, input, listing, listeners, pathCalls, settle } = await mountTree();
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'md', settle);
  press(input, 'ArrowDown');
  const kept = selectedPath(results);
  const calls = pathCalls.length;

  listing.entries = [{ path: 'docs/added.md', kind: 'file' }, ...PATHS.filter((p) => p.path !== 'README.md')];
  listeners.treeChanged({ directories: ['/ws/docs', '/ws'], complete: true });
  listeners.treeChanged({ directories: ['/ws/docs'], complete: true });
  await wait(320);
  await settle();

  assert.equal(pathCalls.length, calls + 1, 'a burst of reports fetches the list once');
  assert.ok(shownPaths(results).includes('docs/added.md'));
  assert.ok(!shownPaths(results).includes('README.md'));
  assert.equal(selectedPath(results), kept);
});

test('a folder switch closes the filter', async (t) => {
  const { dom, tree, bar, container, input, settle } = await mountTree();
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'md', settle);
  await tree.openProject('/other');
  await settle();
  assert.equal(bar.hidden, true);
  assert.equal(input.value, '');
  assert.equal(container.hidden, false);
});

test('hidden files: the list follows the switch and dims what the tree dims', async (t) => {
  const withHidden = [...PATHS, { path: '.env.example', kind: 'file' }];
  const { dom, tree, appStore, results, input, pathCalls, settle } = await mountTree({ paths: withHidden });
  t.after(dom.cleanup);

  tree.openFilter();
  await typeQuery(input, 'env', settle);
  assert.equal(pathCalls.at(-1).showHidden, false);
  await tree.setShowHiddenFiles(true, { persist: false });
  await wait(320);
  await settle();
  assert.equal(appStore.showHiddenFiles, true);
  assert.equal(pathCalls.at(-1).showHidden, true);
  const option = results.querySelector('.tree-filter-option[data-path=".env.example"]');
  assert.equal(option.classList.contains('tree-filter-option--hidden'), true);
});
