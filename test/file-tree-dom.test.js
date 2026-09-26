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

async function mountTree(overrides = {}, extraDeps = {}) {
  const dom = setupRendererDom();
  const { initFileTree } = await importRenderer('components', 'FileTree.js');
  const { appStore } = await importRenderer('state', 'store.js');

  appStore.rootPath = null;
  appStore.activeTreeItem = null;
  appStore.selectedPath = null;
  appStore.selectedIsDirectory = false;

  const entries = fakeFilesystem();
  // Entries main cut off per folder (#76); empty means every folder fits.
  const hidden = {};
  const calls = { importItems: [], moveItem: [], inspectImport: [], readDirectory: [] };
  // Der Dateisystem-Watcher meldet ueber diesen Rueckruf (#158).
  let treeChangedListener = null;

  const api = {
    activateFolder: async () => ({ ok: true }),
    getFolderHistory: async () => ({ paths: [] }),
    readDirectory: async (dir) => {
      calls.readDirectory.push(dir);
      return { entries: entries[dir] ?? [], hidden: hidden[dir] ?? 0 };
    },
    readFile: async () => ({ content: '# Titel', size: 12 }),
    onFsTreeChanged: (callback) => {
      treeChangedListener = callback;
      return () => {
        treeChangedListener = null;
      };
    },
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
    ...extraDeps,
  });

  await tree.openProject(ROOT);
  /** Eine Watcher-Meldung zustellen und abwarten, bis der Baum sie verdaut hat. */
  const emitTreeChanged = async (payload) => {
    treeChangedListener?.(payload);
    await flush();
    await flush();
  };
  return {
    dom,
    tree,
    api,
    appStore,
    calls,
    entries,
    hidden,
    emitTreeChanged,
    container: document.getElementById('tree-container'),
  };
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

test('Klick auf eine Datei holt die eingeklappte mittlere Spalte zurueck', async (t) => {
  // Beim Start neben einem wiederhergestellten Chat ist die Spalte zu
  // (Issue #208) — ein Klick auf eine Datei bliebe sonst folgenlos.
  const reveals = [];
  const { dom, container } = await mountTree({}, { revealContentPane: () => reveals.push(true) });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();

  assert.equal(reveals.length, 1, 'die Spalte muss vor der Vorschau aufgehen');
  assert.equal(document.getElementById('file-preview').classList.contains('hidden'), false);
});

test('ohne revealContentPane bleibt der Klick auf eine Datei wie gehabt', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();

  assert.equal(document.getElementById('preview-filename').textContent, 'README.md');
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
    readDirectory: async (dir) => ({ entries: entries[dir] ?? [], hidden: 0 }),
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

// ── Abgleich mit dem Dateisystem (Issue #158) ───────────────────────────────
//
// Der Watcher im Main meldet nur, welche Ordner sich geaendert haben. Was der
// Baum daraus macht — und was er dabei stehen laesst — steht hier.

/** Ein Eintrag, wie ihn readDirectory liefert. */
const fileEntry = (dir, name) => ({
  name,
  path: `${dir}/${name}`,
  isDirectory: false,
  size: 3,
  modified: 0,
});

test('eine von aussen angelegte Datei erscheint im gemeldeten Ordner', async (t) => {
  const { dom, container, entries, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);

  entries['/ws'] = [...entries['/ws'], fileEntry('/ws', 'neu.txt')];
  await emitTreeChanged({ directories: ['/ws'], complete: true });

  assert.deepEqual(
    [...container.querySelectorAll(':scope > .tree-item .label')].map((el) => el.textContent),
    ['docs', 'README.md', 'neu.txt']
  );
});

test('eine geloeschte Datei verschwindet, auch tief im aufgeklappten Ordner', async (t) => {
  const { dom, container, entries, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/docs').click();
  await flush();
  assert.ok(rowFor(container, '/ws/docs/notes.md'), 'Ausgangslage: der Ordner ist offen');

  entries['/ws/docs'] = [];
  await emitTreeChanged({ directories: ['/ws/docs'], complete: true });

  assert.equal(rowFor(container, '/ws/docs/notes.md'), null);
  const children = container.querySelector('.tree-children[data-path="/ws/docs"]');
  assert.ok(children.classList.contains('expanded'), 'der Ordner bleibt aufgeklappt');
});

test('eine Meldung ohne Aenderung am Ordnerinhalt laesst das DOM unangetastet', async (t) => {
  const { dom, container, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);

  const vorher = rowFor(container, '/ws/README.md');
  // Schreibt die KI oder ein Build-Lauf in eine vorhandene Datei, aendert sich
  // der Ordnerinhalt nicht — dann darf auch nichts neu gezeichnet werden.
  await emitTreeChanged({ directories: ['/ws'], complete: true });

  assert.equal(rowFor(container, '/ws/README.md'), vorher, 'derselbe Knoten, kein Flackern');
});

test('ein nicht sichtbarer Ordner wird gar nicht erst gelesen', async (t) => {
  const { dom, calls, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);

  calls.readDirectory.length = 0;
  await emitTreeChanged({ directories: ['/ws/docs'], complete: true });

  assert.deepEqual(calls.readDirectory, [], 'zugeklappt heisst: spaeter beim Aufklappen');
});

test('eine unvollstaendige Meldung prueft alles Sichtbare', async (t) => {
  const { dom, container, entries, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/docs').click();
  await flush();

  // So sieht ein Zweigwechsel aus: der Watcher weiss nur, dass etwas war.
  entries['/ws/docs'] = [fileEntry('/ws/docs', 'anders.md')];
  await emitTreeChanged({ directories: [], complete: false });

  assert.ok(rowFor(container, '/ws/docs/anders.md'), 'auch ohne Ordnernamen in der Meldung');
  assert.equal(rowFor(container, '/ws/docs/notes.md'), null);
});

test('Auswahl, Tastaturfokus und Scrollposition ueberleben die Aktualisierung', async (t) => {
  const { dom, container, appStore, entries, emitTreeChanged } = await mountTree(
    {},
    { insertChatReference() {} }
  );
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.equal(appStore.selectedPath, '/ws/README.md');

  // Der Fokus steht auf dem @-Knopf der Zeile — mitten in der Tastaturbedienung.
  rowFor(container, '/ws/README.md').querySelector('.tree-item-reference').focus();
  container.scrollTop = 42;

  entries['/ws'] = [...entries['/ws'], fileEntry('/ws', 'neu.txt')];
  await emitTreeChanged({ directories: ['/ws'], complete: true });

  const danach = rowFor(container, '/ws/README.md');
  assert.ok(danach.classList.contains('active'), 'die Auswahl bleibt hervorgehoben');
  assert.equal(appStore.activeTreeItem, danach, 'und zeigt auf den neuen Knoten');
  assert.equal(
    document.activeElement,
    danach.querySelector('.tree-item-reference'),
    'der Fokus wandert auf dieselbe Stelle der neuen Zeile'
  );
  assert.equal(container.scrollTop, 42);
});

test('die geloeschte ausgewaehlte Datei schliesst ihre Vorschau', async (t) => {
  const { dom, container, appStore, entries, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.equal(document.getElementById('file-preview').classList.contains('hidden'), false);

  entries['/ws'] = entries['/ws'].filter((item) => item.name !== 'README.md');
  await emitTreeChanged({ directories: ['/ws'], complete: true });

  assert.equal(appStore.selectedPath, null, 'die Auswahl zeigt auf nichts mehr');
  assert.equal(appStore.activeTreeItem, null);
  assert.equal(document.getElementById('file-preview').classList.contains('hidden'), true);
  assert.equal(document.getElementById('welcome').classList.contains('hidden'), false);
});

test('die offene Vorschau laedt nach, wenn sich ihr Ordner meldet', async (t) => {
  let inhalt = 'alt';
  const { dom, container, emitTreeChanged } = await mountTree({
    readFile: async () => ({ content: inhalt, size: inhalt.length }),
  });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.equal(document.getElementById('preview-content').textContent, 'alt');

  inhalt = 'neu';
  await emitTreeChanged({ directories: ['/ws'], complete: true });

  assert.equal(document.getElementById('preview-content').textContent, 'neu');
});

test('ohne geoeffneten Ordner passiert nichts', async (t) => {
  const { dom, appStore, calls, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);

  appStore.rootPath = null;
  calls.readDirectory.length = 0;
  await emitTreeChanged({ directories: ['/ws'], complete: true });

  assert.deepEqual(calls.readDirectory, []);
});

// ── Cut-off folders (#76) ───────────────────────────────────────────────────

const hiddenNote = (container) => container.querySelector(':scope > .tree-hidden-entries');

test('a folder cut off in main ends in a note with the hidden count', async (t) => {
  const { dom, container, hidden, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);
  assert.equal(hiddenNote(container), null, 'nothing cut, no note');

  hidden['/ws'] = 12345;
  await emitTreeChanged({ directories: ['/ws'], complete: true });

  const note = hiddenNote(container);
  assert.ok(note, 'the refresh notices a count that moved behind unchanged rows');
  assert.equal(note.textContent, '… 12,345 more entries not shown');
  assert.equal(note.classList.contains('tree-item'), false, 'not an entry: no keyboard stop, no drag');
  assert.equal(container.lastElementChild, note, 'after the last entry');
});

test('the note in a subfolder lines up with the names and follows the language', async (t) => {
  const { dom, container, hidden } = await mountTree();
  t.after(dom.cleanup);
  hidden['/ws/docs'] = 1;

  rowFor(container, '/ws/docs').click();
  await flush();

  const children = container.querySelector('.tree-children[data-path="/ws/docs"]');
  const note = hiddenNote(children);
  assert.equal(note.textContent, '… 1 more entry not shown');
  assert.equal(note.style.paddingLeft, '40px', 'depth 1: indent 20 + icon 16 + gap 4, like a file name');

  const { setLocale } = await importRenderer('i18n.js');
  setLocale('de', { force: true });
  t.after(() => setLocale('en', { force: true }));
  assert.equal(note.textContent, '… 1 weiterer Eintrag ausgeblendet');
});

// ── The paths into the content pane go through the file views (#225) ────────

const previewShown = () => !document.getElementById('file-preview').classList.contains('hidden');
const previewText = () => document.getElementById('preview-content')?.textContent;

test('an agent write to the open file (#73) reloads it, a write elsewhere reads nothing', async (t) => {
  const reads = [];
  let content = 'before';
  const { dom, container, tree } = await mountTree({
    readFile: async (p) => { reads.push(p); return { content, size: content.length }; },
  });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  content = 'after';
  await tree.notifyExternalFileWrite('README.md');
  assert.equal(previewText(), 'after');

  reads.length = 0;
  await tree.notifyExternalFileWrite('docs/other.md');
  assert.deepEqual(reads, []);
});

test('deleting the open file from the context menu closes it, deleting something else does not', async (t) => {
  let deleted = null;
  const { dom, container, appStore } = await mountTree({
    onFsItemDeleted: (callback) => { deleted = callback; },
  });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  deleted({ path: '/ws/docs' });
  await flush();
  assert.ok(previewShown(), 'another folder went away, the open file stays');

  deleted({ path: '/ws/README.md' });
  await flush();
  assert.equal(previewShown(), false);
  assert.equal(appStore.selectedPath, null);
  assert.equal(document.getElementById('welcome').classList.contains('hidden'), false);
});

test('clicking a folder moves the selection, but the open file keeps following the disk', async (t) => {
  let content = 'one';
  const { dom, container, appStore, emitTreeChanged } = await mountTree({
    readFile: async () => ({ content, size: content.length }),
  });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  rowFor(container, '/ws/docs').click();
  await flush();
  assert.equal(appStore.selectedPath, '/ws/docs');

  content = 'two';
  await emitTreeChanged({ directories: ['/ws'], complete: true });
  assert.equal(previewText(), 'two');
});

test('a file in a folder deleted outside the app closes with its folder', async (t) => {
  const { dom, container, entries, emitTreeChanged } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/docs').click();
  await flush();
  rowFor(container, '/ws/docs/notes.md').click();
  await flush();
  rowFor(container, '/ws/docs').click(); // collapse, selection on the folder
  await flush();
  entries['/ws'] = entries['/ws'].filter((item) => item.name !== 'docs');
  await emitTreeChanged({ directories: ['/ws'], complete: true });
  assert.equal(previewShown(), false);
});

test('opening another folder unmounts the view', async (t) => {
  const { dom, container, tree } = await mountTree();
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.equal(await tree.openProject('/ws'), true);
  assert.equal(previewShown(), false);
  assert.equal(document.getElementById('preview-body').children.length, 0);
});

async function mountTreeWithDirtyEditor(t, answer) {
  const { createFileViewRegistry } = await importRenderer('file-views', 'registry.js');
  const { plainTextView } = await importRenderer('file-views', 'plain-text-view.js');
  const asked = [];
  let editorContext = null;
  const editor = {
    id: 'test-editor',
    kind: 'editor',
    canHandle: ({ ext }) => ext === 'md',
    mount(hostEl, context) {
      editorContext = context;
      return { update() {}, unmount() {} };
    },
  };
  const activated = [];
  const setup = await mountTree(
    { activateFolder: async (p) => { activated.push(p); return { ok: true }; } },
    {
      fileViews: createFileViewRegistry([editor, plainTextView]),
      confirmLeave: async (question) => { asked.push(question); return answer; },
    }
  );
  t.after(setup.dom.cleanup);
  rowFor(setup.container, '/ws/README.md').click();
  await flush();
  editorContext.setDirty(true);
  activated.length = 0; // the first openProject in mountTree
  return { ...setup, asked, activated };
}

test('an editor that keeps its unsaved changes keeps the selection on its file', async (t) => {
  const { container, appStore, asked } = await mountTreeWithDirtyEditor(t, 'cancel');

  rowFor(container, '/ws/docs').click();
  await flush();
  rowFor(container, '/ws/docs/notes.md').click();
  await flush();

  assert.equal(asked.length, 1);
  assert.equal(asked[0].reason, 'switch-file');
  assert.equal(document.getElementById('preview-filename').textContent, 'README.md');
  assert.equal(appStore.selectedPath, '/ws/docs', 'the folder click moved it, the refused file click did not');
  assert.equal(rowFor(container, '/ws/docs/notes.md').classList.contains('active'), false);
});

test('an editor that keeps its unsaved changes keeps the folder open', async (t) => {
  const { tree, asked, activated } = await mountTreeWithDirtyEditor(t, 'cancel');

  assert.equal(await tree.openProject('/elsewhere'), false);
  assert.equal(asked[0].reason, 'switch-folder');
  assert.deepEqual(activated, [], 'main was never asked to switch');
  assert.equal(document.getElementById('preview-filename').textContent, 'README.md');
});

test('discarding lets the folder switch through', async (t) => {
  const { tree, activated } = await mountTreeWithDirtyEditor(t, 'discard');

  assert.equal(await tree.openProject('/elsewhere'), true);
  assert.deepEqual(activated, ['/elsewhere']);
  assert.equal(previewShown(), false);
});
