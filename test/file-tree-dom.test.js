// Dateibaum am echten DOM (Issue #78).
//
// test/file-tree-drop.test.js prueft die beiden DOM-freien Praedikate
// (isExternalFileDrop, importDestDirFor). Hier geht es um das, was dort nicht
// hinkommt: welcher Handler an welchem Ziel haengt, in welcher Reihenfolge er
// das DataTransfer liest, was am Baum danach steht (#101).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  importRenderer,
  setupRendererDom,
  createDataTransfer,
  dispatchDragEvent,
  flush,
} = require('./helpers/dom.js');

const ROOT = '/ws';

function fakeFilesystem() {
  return {
    '/ws': [
      { name: 'docs', path: '/ws/docs', isDirectory: true },
      { name: 'README.md', path: '/ws/README.md', isDirectory: false, size: 12, modified: 0 },
    ],
    '/ws/docs': [
      { name: 'notes.md', path: '/ws/docs/notes.md', isDirectory: false, size: 5, modified: 0 },
    ],
  };
}

async function mountTree(overrides = {}) {
  const dom = setupRendererDom();
  const { initFileTree } = await importRenderer('components', 'FileTree.js');
  const { appStore } = await importRenderer('state', 'store.js');

  appStore.rootPath = null;
  appStore.activeTreeItem = null;
  appStore.selectedPath = null;
  appStore.selectedIsDirectory = false;

  const entries = fakeFilesystem();
  const calls = { importItems: [], moveItem: [], inspectImport: [] };

  const api = {
    activateFolder: async () => ({ ok: true }),
    getFolderHistory: async () => ({ paths: [] }),
    readDirectory: async (dir) => entries[dir] ?? [],
    readFile: async () => ({ content: '# Titel', size: 12 }),
    moveItem: async (source, dest) => { calls.moveItem.push([source, dest]); return {}; },
    inspectImport: async (sources, dest) => {
      calls.inspectImport.push([sources, dest]);
      return { ok: true, dirs: 0, files: sources.length };
    },
    importItems: async (sources, dest) => { calls.importItems.push([sources, dest]); return { ok: true }; },
    getPathForFile: (file) => file.nativePath,
    onFsItemDeleted: () => {},
    showFileContextMenu: async () => ({}),
    ...overrides,
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
  return { dom, tree, api, appStore, calls, entries, container: document.getElementById('tree-container') };
}

/** Eine Datei, wie sie ein Drop aus Finder/Explorer mitbringt. */
const droppedFile = (nativePath) => ({ name: nativePath.split('/').pop(), nativePath });

const rowFor = (container, path) => container.querySelector(`.tree-item[data-path="${path}"]`);

test('openProject zeichnet die oberste Ebene aus dem Main-Prozess', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);

  const rows = [...container.querySelectorAll('.tree-item')];
  assert.deepEqual(rows.map((r) => r.querySelector('.label').textContent), ['docs', 'README.md']);
  assert.equal(rows[0].dataset.isDirectory, 'true');
  assert.equal(document.getElementById('project-name').textContent, 'ws');
  // Ordner bringen ihren Kind-Container gleich mit, noch ungeladen.
  const children = container.querySelector('.tree-children[data-path="/ws/docs"]');
  assert.equal(children.dataset.loaded, 'false');
  assert.equal(children.classList.contains('expanded'), false);
});

test('Klick auf eine Ordnerzeile laedt die Ebene und klappt sie auf', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/docs').click();
  await flush();

  const children = container.querySelector('.tree-children[data-path="/ws/docs"]');
  assert.equal(children.dataset.loaded, 'true');
  assert.ok(children.classList.contains('expanded'));
  assert.ok(rowFor(container, '/ws/docs').querySelector('.arrow').classList.contains('expanded'));
  assert.equal(children.querySelector('.tree-item .label').textContent, 'notes.md');

  // Zweiter Klick klappt wieder zu, ohne neu zu laden.
  rowFor(container, '/ws/docs').click();
  await flush();
  assert.equal(children.classList.contains('expanded'), false);
  assert.equal(children.dataset.loaded, 'true');
});

test('Klick auf eine Datei oeffnet die Vorschau und markiert die Zeile', async (t) => {
  const { dom, container, appStore } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();

  assert.ok(document.getElementById('welcome').classList.contains('hidden'));
  assert.equal(document.getElementById('file-preview').classList.contains('hidden'), false);
  assert.equal(document.getElementById('preview-filename').textContent, 'README.md');
  assert.equal(document.getElementById('preview-content').textContent, '# Titel');
  assert.ok(rowFor(container, '/ws/README.md').classList.contains('active'));
  assert.equal(appStore.selectedPath, '/ws/README.md');
});

test('Drop auf eine Ordnerzeile uebernimmt in diesen Ordner', async (t) => {
  const { dom, container, calls } = await mountTree();
  t.after(dom.cleanup);

  const dataTransfer = createDataTransfer({ files: [droppedFile('/extern/bild.png')] });
  dispatchDragEvent(rowFor(container, '/ws/docs'), 'drop', { dataTransfer });
  await flush();

  assert.deepEqual(calls.importItems, [[['/extern/bild.png'], '/ws/docs']]);
});

test('Drop auf eine Dateizeile oder neben den Baum landet im Projektordner', async (t) => {
  const { dom, container, calls } = await mountTree();
  t.after(dom.cleanup);

  // Dateizeilen haben keinen eigenen Drop-Handler; der Container faengt das
  // Ereignis auf und faellt auf den Projektordner zurueck.
  dispatchDragEvent(rowFor(container, '/ws/README.md'), 'drop', {
    dataTransfer: createDataTransfer({ files: [droppedFile('/extern/a.txt')] }),
  });
  await flush();
  dispatchDragEvent(container, 'drop', {
    dataTransfer: createDataTransfer({ files: [droppedFile('/extern/b.txt')] }),
  });
  await flush();

  assert.deepEqual(calls.importItems, [
    [['/extern/a.txt'], ROOT],
    [['/extern/b.txt'], ROOT],
  ]);
});

test('Die Pfade werden vor dem ersten await aus dem DataTransfer geholt', async (t) => {
  const { dom, container, calls } = await mountTree();
  t.after(dom.cleanup);

  const dataTransfer = createDataTransfer({ files: [droppedFile('/extern/spaet.txt')] });
  dispatchDragEvent(rowFor(container, '/ws/docs'), 'drop', { dataTransfer });
  // dispatchEvent kehrt am ersten await des Handlers zurueck. Ab hier ist das
  // DataTransfer im Browser leer — wer erst danach liest, bekommt nichts (#101).
  dataTransfer.files = [];
  await flush();

  assert.deepEqual(calls.importItems, [[['/extern/spaet.txt'], '/ws/docs']]);
});

test('Waehrend eines laufenden Imports ist der Baum busy und ein zweiter Drop wirkungslos', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { dom, container } = await mountTree({
    importItems: async (sources, dest) => { calls.push([sources, dest]); await pending; return { ok: true }; },
  });
  t.after(dom.cleanup);

  dispatchDragEvent(rowFor(container, '/ws/docs'), 'drop', {
    dataTransfer: createDataTransfer({ files: [droppedFile('/extern/eins.txt')] }),
  });
  await flush();
  assert.ok(container.classList.contains('import-busy'));

  dispatchDragEvent(rowFor(container, '/ws/docs'), 'drop', {
    dataTransfer: createDataTransfer({ files: [droppedFile('/extern/zwei.txt')] }),
  });
  await flush();
  assert.equal(calls.length, 1, 'der zweite Drop darf nicht durchkommen');

  release();
  await flush();
  assert.equal(container.classList.contains('import-busy'), false);
});

test('Nach dem Import steht die Datei im Baum und aufgeklappte Ordner bleiben offen', async (t) => {
  const entries = fakeFilesystem();
  const { dom, container } = await mountTree({
    readDirectory: async (dir) => entries[dir] ?? [],
    importItems: async (sources, dest) => {
      entries[dest] = [
        ...entries[dest],
        { name: 'neu.txt', path: `${dest}/neu.txt`, isDirectory: false, size: 3, modified: 0 },
      ];
      return { ok: true };
    },
  });
  t.after(dom.cleanup);

  rowFor(container, '/ws/docs').click();
  await flush();

  dispatchDragEvent(container, 'drop', {
    dataTransfer: createDataTransfer({ files: [droppedFile('/extern/neu.txt')] }),
  });
  await flush();

  assert.ok(rowFor(container, '/ws/neu.txt'), 'die uebernommene Datei fehlt im Baum');
  assert.ok(
    container.querySelector('.tree-children[data-path="/ws/docs"]').classList.contains('expanded'),
    'der aufgeklappte Ordner ist zugefallen'
  );
});

test('Ein Drag aus dem Baum verschiebt, statt zu uebernehmen', async (t) => {
  const { dom, container, calls } = await mountTree();
  t.after(dom.cleanup);

  const dataTransfer = createDataTransfer({ files: [droppedFile('/extern/irrelevant.txt')] });
  dispatchDragEvent(rowFor(container, '/ws/README.md'), 'dragstart', { dataTransfer });
  dispatchDragEvent(rowFor(container, '/ws/docs'), 'drop', { dataTransfer });
  await flush();

  assert.deepEqual(calls.moveItem, [['/ws/README.md', '/ws/docs']]);
  assert.deepEqual(calls.importItems, []);
});

test('dragover markiert Ordnerzeile und freie Flaeche unterschiedlich', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);

  const dataTransfer = createDataTransfer({ files: [droppedFile('/extern/a.txt')] });
  const folderRow = rowFor(container, '/ws/docs');

  dispatchDragEvent(folderRow, 'dragenter', { dataTransfer });
  assert.ok(folderRow.classList.contains('drop-target--import'));
  assert.equal(folderRow.classList.contains('drop-target'), false, 'Import ist kein Verschieben');
  // Der Ordner-Handler laesst das Ereignis nicht bis zum Container durch.
  assert.equal(container.classList.contains('drop-target-root--import'), false);

  const overFolder = dispatchDragEvent(folderRow, 'dragover', { dataTransfer });
  assert.equal(overFolder.defaultPrevented, true);
  assert.equal(dataTransfer.dropEffect, 'copy');

  dispatchDragEvent(folderRow, 'dragleave', { dataTransfer, relatedTarget: container });
  assert.equal(folderRow.classList.contains('drop-target--import'), false);

  dispatchDragEvent(container, 'dragover', { dataTransfer });
  assert.ok(container.classList.contains('drop-target-root--import'));
});
