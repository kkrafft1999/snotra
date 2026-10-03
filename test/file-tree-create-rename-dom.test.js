// New file, new folder and rename in the tree (#349): the name is typed into
// the tree itself, the header has two buttons for "New", F2 renames, and the
// selection and the preview follow what was created or renamed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const ROOT = '/ws';

const fileEntry = (dir, name) => ({ name, path: `${dir}/${name}`, isDirectory: false, size: 1, modified: 0 });
const folderEntry = (dir, name) => ({ name, path: `${dir}/${name}`, isDirectory: true });

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

  const entries = {
    '/ws': [folderEntry('/ws', 'docs'), fileEntry('/ws', 'README.md')],
    '/ws/docs': [folderEntry('/ws/docs', 'deep'), fileEntry('/ws/docs', 'notes.md')],
    '/ws/docs/deep': [],
  };
  const listeners = {};
  const calls = { create: [], rename: [], read: [], menu: [] };
  const answers = { create: null, rename: null };
  const sortEntries = (list) => list.sort((a, b) => (a.isDirectory === b.isDirectory
    ? a.name.localeCompare(b.name)
    : (a.isDirectory ? -1 : 1)));
  const api = {
    activateFolder: async () => ({ ok: true }),
    getFolderHistory: async () => ({ paths: [] }),
    readDirectory: async (dir) => ({ entries: [...(entries[dir] ?? [])], hidden: 0 }),
    readFile: async (path) => { calls.read.push(path); return { content: 'text', size: 4 }; },
    onFsTreeChanged: (cb) => { listeners.treeChanged = cb; },
    onFsItemDeleted: () => {},
    onFsClearAgentMark: () => {},
    onFsBeginCreate: (cb) => { listeners.beginCreate = cb; },
    onFsBeginRename: (cb) => { listeners.beginRename = cb; },
    showFileContextMenu: async (path, options) => { calls.menu.push([path, options]); return { ok: true }; },
    createItem: async (parent, name, kind) => {
      calls.create.push([parent, name, kind]);
      if (answers.create) return answers.create;
      const entry = kind === 'directory' ? folderEntry(parent, name) : fileEntry(parent, name);
      entries[parent] = sortEntries([...(entries[parent] ?? []), entry]);
      if (kind === 'directory') entries[entry.path] = [];
      return { ok: true, path: entry.path };
    },
    renameItem: async (itemPath, name) => {
      calls.rename.push([itemPath, name]);
      if (answers.rename) return answers.rename;
      const parent = itemPath.slice(0, itemPath.lastIndexOf('/'));
      const newPath = `${parent}/${name}`;
      entries[parent] = sortEntries(entries[parent].map((e) => (e.path === itemPath
        ? { ...e, name, path: newPath }
        : e)));
      for (const dir of Object.keys(entries)) {
        if (dir === itemPath || dir.startsWith(`${itemPath}/`)) {
          const moved = newPath + dir.slice(itemPath.length);
          entries[moved] = entries[dir].map((e) => ({ ...e, path: newPath + e.path.slice(itemPath.length) }));
          delete entries[dir];
        }
      }
      return { ok: true, path: newPath };
    },
  };
  const tree = initFileTree({
    api,
    appStore,
    onInputChanged() {},
    onWorkspaceChanged() {},
    onProjectOpened() {},
    sendChatMessage() {},
    activeProviderConfigured: () => true,
    insertChatReference() {},
  });
  await tree.openProject(ROOT);
  const settle = async () => { for (let i = 0; i < 6; i += 1) await flush(); };
  await settle();
  return {
    dom, tree, appStore, entries, listeners, calls, answers, settle,
    container: document.getElementById('tree-container'),
  };
}

const rowFor = (container, path) => container.querySelector(`.tree-item[data-path="${path}"]`);
const field = (container) => container.querySelector('.tree-name-input');
const message = (container) => container.querySelector('.tree-name-error');

function press(target, key, init = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('the header shows "New file" and "New folder" once a folder is open', async (t) => {
  const { dom } = await mountTree();
  t.after(dom.cleanup);

  const newFile = document.getElementById('btn-tree-new-file');
  const newFolder = document.getElementById('btn-tree-new-folder');
  assert.equal(newFile.hidden, false);
  assert.equal(newFolder.hidden, false);
  assert.equal(newFile.getAttribute('aria-label'), 'New file');
  assert.equal(newFolder.getAttribute('aria-label'), 'New folder');
});

test('F2 puts the name into a field, selected up to the extension; Escape leaves it unchanged', async (t) => {
  const { dom, container, calls, settle } = await mountTree();
  t.after(dom.cleanup);
  const row = rowFor(container, '/ws/README.md');
  row.focus();

  press(row, 'F2');
  await settle();

  const input = field(container);
  assert.ok(input, 'the field is open');
  assert.equal(input.parentElement === row, true, 'in the row itself');
  assert.equal(input.value, 'README.md');
  assert.equal([input.selectionStart, input.selectionEnd].join(), '0,6');
  assert.equal(input.getAttribute('aria-label'), 'New name for README.md');
  assert.equal(document.activeElement === input, true);
  assert.equal(row.querySelector('.label').hidden, true);
  assert.equal(row.draggable, false);

  press(input, 'ArrowDown');
  assert.equal(document.activeElement === input, true, 'the tree\'s arrow keys are not the field\'s');

  press(input, 'Escape');
  await settle();
  assert.equal(field(container), null);
  assert.equal(row.querySelector('.label').hidden, false);
  assert.equal(row.draggable, true);
  assert.equal(document.activeElement === rowFor(container, '/ws/README.md'), true);
  assert.deepEqual(calls.rename, []);
});

test('Enter renames; the row comes back under its new name and keeps the focus', async (t) => {
  const { dom, container, calls, settle } = await mountTree();
  t.after(dom.cleanup);
  rowFor(container, '/ws/README.md').focus();
  press(document.activeElement, 'F2');
  await settle();

  const input = field(container);
  type(input, '  Lies mich.md ');
  press(input, 'Enter');
  await settle();

  assert.deepEqual(calls.rename, [['/ws/README.md', 'Lies mich.md']]);
  assert.equal(field(container), null);
  assert.equal(rowFor(container, '/ws/README.md'), null);
  assert.equal(document.activeElement === rowFor(container, '/ws/Lies mich.md'), true);
});

test('a name already in the folder is refused while typing, and Enter sends nothing', async (t) => {
  const { dom, container, calls, settle } = await mountTree();
  t.after(dom.cleanup);
  rowFor(container, '/ws/README.md').focus();
  press(document.activeElement, 'F2');
  await settle();
  const input = field(container);

  type(input, 'docs');
  assert.equal(message(container).hidden, false);
  assert.equal(message(container).textContent, '“docs” already exists here. Choose another name.');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), message(container).id);
  assert.equal(message(container).getAttribute('aria-live'), 'polite');

  press(input, 'Enter');
  await settle();
  assert.deepEqual(calls.rename, []);
  assert.ok(field(container), 'the field stays open');

  type(input, 'a/b');
  assert.equal(message(container).textContent, 'A name cannot contain / or \\.');
  type(input, 'nul.md');
  assert.equal(message(container).textContent, '“nul.md” is reserved on Windows. Choose another name.');
  type(input, 'fine.md');
  assert.equal(message(container).hidden, true);
  assert.equal(input.hasAttribute('aria-invalid'), false);
});

test('a refusal from main is shown and the field stays open with the name', async (t) => {
  const { dom, container, calls, answers, settle } = await mountTree();
  t.after(dom.cleanup);
  answers.rename = { error: 'EACCES: permission denied', reason: 'permission' };
  rowFor(container, '/ws/README.md').focus();
  press(document.activeElement, 'F2');
  await settle();
  const input = field(container);

  type(input, 'other.md');
  press(input, 'Enter');
  await settle();

  assert.equal(calls.rename.length, 1);
  assert.equal(field(container) === input, true);
  assert.equal(input.value, 'other.md');
  assert.equal(message(container).textContent, 'No permission to write in this folder.');
  assert.equal(document.activeElement === input, true);
});

test('"New file" in the header creates in the selected folder; the new file is selected and shown', async (t) => {
  const { dom, container, calls, appStore, settle } = await mountTree();
  t.after(dom.cleanup);
  rowFor(container, '/ws/docs').click();
  await settle();
  assert.equal(appStore.selectedPath, '/ws/docs');

  document.getElementById('btn-tree-new-file').click();
  await settle();

  const input = field(container);
  const editRow = input.parentElement;
  assert.equal(editRow.classList.contains('tree-edit-row'), true);
  assert.equal(editRow.classList.contains('tree-item'), false, 'no entry yet: navigation passes it');
  assert.equal(editRow.parentElement.dataset.path, '/ws/docs');
  const order = (parent) => [...parent.children]
    .filter((el) => el.matches('.tree-item, .tree-edit-row'))
    .map((el) => el.dataset.path ?? 'field');
  assert.deepEqual(order(editRow.parentElement), ['/ws/docs/deep', 'field', '/ws/docs/notes.md'], 'after the folders, before the files');
  assert.equal(editRow.querySelector('.indent').style.width, '20px', 'one level in');
  assert.equal(input.getAttribute('aria-label'), 'Name of the new file');

  press(input, 'Enter');
  await settle();
  assert.equal(message(container).textContent, 'Enter a name.');
  assert.deepEqual(calls.create, []);

  type(input, 'plan.md');
  press(input, 'Enter');
  await settle();

  assert.deepEqual(calls.create, [['/ws/docs', 'plan.md', 'file']]);
  assert.equal(container.querySelector('.tree-edit-row'), null);
  const created = rowFor(container, '/ws/docs/plan.md');
  assert.equal(created.getAttribute('aria-selected'), 'true');
  assert.equal(appStore.selectedPath, '/ws/docs/plan.md');
  assert.equal(calls.read.at(-1), '/ws/docs/plan.md', 'the preview shows it');
  assert.equal(document.activeElement === created, true);
});

test('"New folder" next to a selected file creates in its folder, and the folder is selected', async (t) => {
  const { dom, container, calls, appStore, settle } = await mountTree();
  t.after(dom.cleanup);
  rowFor(container, '/ws/README.md').click();
  await settle();

  document.getElementById('btn-tree-new-folder').click();
  await settle();
  const input = field(container);
  assert.equal(input.parentElement.parentElement === container, true, 'in the open folder');
  const first = [...container.children].find((el) => el.matches('.tree-item, .tree-edit-row'));
  assert.equal(first === input.parentElement, true, 'folders first');
  assert.equal(input.getAttribute('aria-label'), 'Name of the new folder');

  type(input, 'Ablage');
  press(input, 'Enter');
  await settle();

  assert.deepEqual(calls.create, [['/ws', 'Ablage', 'directory']]);
  assert.equal(appStore.selectedPath, '/ws/Ablage');
  assert.equal(appStore.selectedIsDirectory, true);
  assert.equal(document.activeElement === rowFor(container, '/ws/Ablage'), true);
});

test('cancelling a new entry gives the focus back to the button that asked', async (t) => {
  const { dom, container, calls, settle } = await mountTree();
  t.after(dom.cleanup);
  const button = document.getElementById('btn-tree-new-file');
  button.focus();
  button.click();
  await settle();

  press(field(container), 'Escape');
  await settle();

  assert.equal(container.querySelector('.tree-edit-row'), null);
  assert.equal(document.activeElement === button, true);
  assert.deepEqual(calls.create, []);
});

test('the context menu\'s "New" opens a closed folder and asks inside it', async (t) => {
  const { dom, container, listeners, settle } = await mountTree();
  t.after(dom.cleanup);
  assert.equal(rowFor(container, '/ws/docs').getAttribute('aria-expanded'), 'false');

  listeners.beginCreate({ path: '/ws/docs/deep', kind: 'file' });
  await settle();

  assert.equal(rowFor(container, '/ws/docs').getAttribute('aria-expanded'), 'true');
  assert.equal(rowFor(container, '/ws/docs/deep').getAttribute('aria-expanded'), 'true');
  const editRow = field(container).parentElement;
  assert.equal(editRow.parentElement.dataset.path, '/ws/docs/deep');
  assert.equal(editRow.querySelector('.indent').style.width, '36px');
});

test('focus leaving the field for elsewhere in the window closes it unchanged', async (t) => {
  const { dom, container, listeners, calls, settle } = await mountTree();
  t.after(dom.cleanup);
  listeners.beginRename({ path: '/ws/README.md' });
  await settle();
  assert.ok(field(container));

  const chatInput = document.getElementById('chat-input');
  chatInput.focus();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();

  assert.equal(field(container), null);
  assert.deepEqual(calls.rename, []);
  assert.equal(document.activeElement === chatInput, true, 'the focus stays where it went');
});

test('renaming the file on show keeps it on show and selected, under its new name', async (t) => {
  const { dom, container, appStore, calls, settle } = await mountTree();
  t.after(dom.cleanup);
  rowFor(container, '/ws/README.md').click();
  await settle();
  assert.equal(appStore.selectedPath, '/ws/README.md');

  rowFor(container, '/ws/README.md').focus();
  press(document.activeElement, 'F2');
  await settle();
  type(field(container), 'INFO.md');
  press(field(container), 'Enter');
  await settle();

  assert.equal(appStore.selectedPath, '/ws/INFO.md');
  assert.equal(rowFor(container, '/ws/INFO.md').getAttribute('aria-selected'), 'true');
  assert.equal(calls.read.at(-1), '/ws/INFO.md');
});

test('renaming a folder carries its open subfolders and the file on show along', async (t) => {
  const { dom, container, appStore, calls, settle } = await mountTree();
  t.after(dom.cleanup);
  rowFor(container, '/ws/docs').click();
  await settle();
  rowFor(container, '/ws/docs/deep').click();
  await settle();
  rowFor(container, '/ws/docs/notes.md').click();
  await settle();

  rowFor(container, '/ws/docs').focus();
  press(document.activeElement, 'F2');
  await settle();
  assert.equal(field(container).selectionEnd, 4, 'a folder\'s name is selected in full');
  type(field(container), 'Doku');
  press(field(container), 'Enter');
  await settle();

  assert.equal(rowFor(container, '/ws/Doku').getAttribute('aria-expanded'), 'true');
  assert.equal(rowFor(container, '/ws/Doku/deep').getAttribute('aria-expanded'), 'true');
  assert.equal(appStore.selectedPath, '/ws/Doku/notes.md');
  assert.equal(calls.read.at(-1), '/ws/Doku/notes.md');
});

test('a watcher report while the field is open waits for it instead of redrawing it away', async (t) => {
  const { dom, container, entries, listeners, settle } = await mountTree();
  t.after(dom.cleanup);
  listeners.beginRename({ path: '/ws/README.md' });
  await settle();
  const input = field(container);

  entries['/ws'].push(fileEntry('/ws', 'later.md'));
  listeners.treeChanged({ directories: ['/ws'], complete: true });
  await settle();
  assert.equal(field(container) === input, true, 'still the same field');
  assert.equal(rowFor(container, '/ws/later.md'), null);

  press(input, 'Escape');
  await settle();
  assert.ok(rowFor(container, '/ws/later.md'), 'the report ran once the field closed');
});

test('the empty space below the rows opens the menu of the open folder', async (t) => {
  const { dom, container, calls } = await mountTree();
  t.after(dom.cleanup);

  container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  rowFor(container, '/ws/README.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

  assert.deepEqual(calls.menu.map(([path]) => path), ['/ws', '/ws/README.md']);
});
