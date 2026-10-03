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
  // A module singleton: without this, the switch of one test leaks into the next (#436).
  appStore.showHiddenFiles = false;

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
    // The tree hands over the dropped File objects, the preload resolves their
    // paths (#646); the fake records the path behind each one.
    inspectImport: async (files, dest) => {
      calls.inspectImport.push([files.map((file) => file.nativePath), dest]);
      return { ok: true, dirs: 0, files: files.length };
    },
    importItems: async (files, dest) => {
      calls.importItems.push([files.map((file) => file.nativePath), dest]);
      return { ok: true };
    },
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

/**
 * The text of whichever view shows the file. `README.md` goes to the Markdown
 * view since #344; without `marked` in happy-dom it renders escaped text, so
 * the text reads the same as in the plain-text view.
 */
const paneText = () => document.querySelector('#preview-body > .file-view')?.textContent ?? null;

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
  assert.equal(paneText(), '# Titel');
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
  assert.equal(paneText(), 'alt');

  inhalt = 'neu';
  await emitTreeChanged({ directories: ['/ws'], complete: true });

  assert.equal(paneText(), 'neu');
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
  assert.equal(
    note.style.paddingLeft,
    '56px',
    'depth 1: indent 20 + arrow slot 16 + icon 16 + gap 4, like a file name (#639)'
  );

  const { setLocale } = await importRenderer('i18n.js');
  setLocale('de', { force: true });
  t.after(() => setLocale('en', { force: true }));
  // Not "ausgeblendet": that is what the hidden-files switch does (#641).
  assert.equal(note.textContent, '… 1 weiterer Eintrag nicht angezeigt');
});

// ── The paths into the content pane go through the file views (#225) ────────

const previewShown = () => !document.getElementById('file-preview').classList.contains('hidden');
const previewText = paneText;

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

// ── Links from the preview (#344) ───────────────────────────────────────────

/** A registry with one view that hands its context to the test. */
async function capturingViews() {
  const { createFileViewRegistry } = await importRenderer('file-views', 'registry.js');
  const contexts = [];
  const fileViews = createFileViewRegistry([{
    id: 'capture',
    kind: 'viewer',
    canHandle: () => true,
    mount(hostEl, context) {
      contexts.push(context);
      hostEl.textContent = context.file.name;
      return { update() {}, unmount() {} };
    },
  }]);
  return { fileViews, contexts };
}

test('a link from the preview unfolds the folders, selects the file and shows it', async (t) => {
  const { fileViews, contexts } = await capturingViews();
  const { dom, container, appStore } = await mountTree({}, { fileViews });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.equal(contexts[0].workspaceRoot, '/ws');

  assert.deepEqual(await contexts[0].openFile('/ws/docs/notes.md'), { ok: true });
  await flush();
  const docs = container.querySelector('.tree-children[data-path="/ws/docs"]');
  assert.ok(docs.classList.contains('expanded'), 'the folder above is open');
  assert.ok(rowFor(container, '/ws/docs/notes.md').classList.contains('active'));
  assert.equal(appStore.selectedPath, '/ws/docs/notes.md');
  assert.equal(document.getElementById('preview-filename').textContent, 'notes.md');
});

test('a link to a folder selects and opens it, the preview stays', async (t) => {
  const { fileViews, contexts } = await capturingViews();
  const { dom, container, appStore } = await mountTree({}, { fileViews });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.deepEqual(await contexts[0].openFile('/ws/docs'), { ok: true });
  assert.ok(rowFor(container, '/ws/docs').classList.contains('active'));
  assert.equal(appStore.selectedIsDirectory, true);
  assert.equal(document.getElementById('preview-filename').textContent, 'README.md');
});

test('a link outside the folder, or to nothing, is refused with its reason', async (t) => {
  const { fileViews, contexts } = await capturingViews();
  const { dom, container, appStore } = await mountTree({
    readFile: async (p) => (p === '/ws/README.md' ? { content: '# Titel', size: 7 } : { error: 'ENOENT' }),
  }, { fileViews });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.deepEqual(await contexts[0].openFile('/etc/passwd'), { ok: false, reason: 'outside' });
  assert.deepEqual(await contexts[0].openFile('/ws-other/a.md'), { ok: false, reason: 'outside' });
  assert.deepEqual(await contexts[0].openFile('/ws/missing.md'), { ok: false, reason: 'not-found' });
  assert.equal(appStore.selectedPath, '/ws/README.md', 'nothing moved');
});

test('a file the listing left out still opens, without a row to mark', async (t) => {
  const { fileViews, contexts } = await capturingViews();
  const { dom, container, appStore } = await mountTree({}, { fileViews });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.deepEqual(await contexts[0].openFile('/ws/.hidden-notes.md'), { ok: true });
  assert.equal(document.getElementById('preview-filename').textContent, '.hidden-notes.md');
  assert.equal(container.querySelector('.tree-item.active'), null);
  assert.equal(appStore.selectedPath, '/ws/.hidden-notes.md');
});

// ── Hidden files (#436) ─────────────────────────────────────────────────────

function hiddenFilesystem() {
  return {
    '/ws': [
      { name: '.github', path: '/ws/.github', isDirectory: true },
      { name: 'docs', path: '/ws/docs', isDirectory: true },
      { name: '.env', path: '/ws/.env', isDirectory: false, size: 3, modified: 0 },
      { name: 'README.md', path: '/ws/README.md', isDirectory: false, size: 12, modified: 0 },
    ],
    '/ws/.github': [
      { name: 'workflows', path: '/ws/.github/workflows', isDirectory: true },
    ],
    '/ws/.github/workflows': [
      { name: 'ci.yml', path: '/ws/.github/workflows/ci.yml', isDirectory: false, size: 1, modified: 0 },
    ],
    '/ws/docs': [
      { name: 'notes.md', path: '/ws/docs/notes.md', isDirectory: false, size: 5, modified: 0 },
    ],
  };
}

/** A tree whose main side filters like the real one: dot entries only with showHidden. */
async function mountHiddenTree(t, extraDeps = {}) {
  const listing = hiddenFilesystem();
  const reads = [];
  const prefWrites = [];
  const mounted = await mountTree({
    readDirectory: async (dir, options) => {
      reads.push({ dir, showHidden: options?.showHidden });
      const all = listing[dir] ?? [];
      const entries = options?.showHidden === true ? all : all.filter((item) => !item.name.startsWith('.'));
      return { entries, hidden: 0 };
    },
    setUIPrefs: async (patch) => {
      prefWrites.push(patch);
      return patch;
    },
  }, extraDeps);
  t.after(mounted.dom.cleanup);
  return { ...mounted, listing, reads, prefWrites };
}

const topLabels = (container) => [...container.children]
  .filter((el) => el.classList.contains('tree-item'))
  .map((row) => row.querySelector('.label').textContent);

// Since #676 a check box in the header's `⋯` menu, no eye button of its own.
const hiddenFilesItem = () => document.querySelector('#tree-actions-menu [data-action="hidden-files"]');

async function until(condition) {
  for (let i = 0; i < 50 && !condition(); i += 1) await flush();
  assert.ok(condition(), 'the condition came true');
}

test('hidden files are off at first: the menu entry is unchecked and the dot entries stay out', async (t) => {
  const { container, reads } = await mountHiddenTree(t);

  assert.deepEqual(topLabels(container), ['docs', 'README.md']);
  assert.equal(hiddenFilesItem().getAttribute('role'), 'menuitemcheckbox');
  assert.equal(hiddenFilesItem().getAttribute('aria-checked'), 'false');
  assert.equal(hiddenFilesItem().querySelector('.tree-actions-label').textContent, 'Show hidden files');
  assert.notEqual(hiddenFilesItem().querySelector('.tree-actions-shortcut').textContent, '', 'the entry names the shortcut');
  assert.ok(reads.every((read) => read.showHidden === false), 'main is asked without hidden files');
});

test('the menu entry shows hidden files, dims them, and remembers the switch', async (t) => {
  const { container, reads, prefWrites } = await mountHiddenTree(t);

  document.getElementById('btn-tree-actions').click();
  hiddenFilesItem().click();
  await until(() => prefWrites.length === 1);

  assert.deepEqual(topLabels(container), ['.github', 'docs', '.env', 'README.md']);
  assert.equal(rowFor(container, '/ws/.github').classList.contains('tree-item--hidden'), true);
  assert.equal(rowFor(container, '/ws/.env').classList.contains('tree-item--hidden'), true);
  assert.equal(rowFor(container, '/ws/docs').classList.contains('tree-item--hidden'), false);
  // The label stays; the check carries the state.
  assert.equal(hiddenFilesItem().getAttribute('aria-checked'), 'true');
  assert.equal(hiddenFilesItem().querySelector('.tree-actions-label').textContent, 'Show hidden files');
  assert.equal(document.getElementById('tree-actions-menu').classList.contains('hidden'), true, 'the choice closed the menu');
  assert.deepEqual(prefWrites, [{ showHiddenFiles: true }]);
  assert.equal(reads.at(-1).showHidden, true);
});

test('everything below a hidden folder is dimmed, even without a dot of its own', async (t) => {
  const { tree, container } = await mountHiddenTree(t);
  await tree.setShowHiddenFiles(true);

  rowFor(container, '/ws/.github').click();
  await flush();
  rowFor(container, '/ws/.github/workflows').click();
  await flush();

  assert.equal(rowFor(container, '/ws/.github/workflows').classList.contains('tree-item--hidden'), true);
  assert.equal(rowFor(container, '/ws/.github/workflows/ci.yml').classList.contains('tree-item--hidden'), true);
});

test('switching keeps open folders, and hidden folders open again when they come back', async (t) => {
  const { tree, container } = await mountHiddenTree(t);
  rowFor(container, '/ws/docs').click();
  await flush();
  await tree.setShowHiddenFiles(true);
  rowFor(container, '/ws/.github').click();
  await flush();

  await tree.setShowHiddenFiles(false);
  assert.equal(rowFor(container, '/ws/.github'), null);
  assert.ok(rowFor(container, '/ws/docs/notes.md'), 'docs stays open');
  assert.equal(
    container.querySelector('.tree-children[data-path="/ws/docs"]').classList.contains('expanded'),
    true
  );

  await tree.setShowHiddenFiles(true);
  assert.equal(
    container.querySelector('.tree-children[data-path="/ws/.github"]').classList.contains('expanded'),
    true,
    '.github is open again, as it was'
  );
  assert.ok(rowFor(container, '/ws/.github/workflows'));
  assert.ok(rowFor(container, '/ws/docs/notes.md'));
});

test('hiding lets go of a hidden selection, but its preview stays — also through a watcher report', async (t) => {
  const { tree, container, appStore, emitTreeChanged } = await mountHiddenTree(t);
  await tree.setShowHiddenFiles(true);
  rowFor(container, '/ws/.env').click();
  await flush();
  assert.equal(previewShown(), true, 'a dot file is text and opens in the preview');

  await tree.setShowHiddenFiles(false);
  assert.equal(rowFor(container, '/ws/.env'), null);
  assert.equal(appStore.selectedPath, null);
  assert.equal(appStore.activeTreeItem, null);
  assert.equal(previewShown(), true, 'the file is not gone, only not shown');

  // The row is missing, but that is the filter, not a deletion.
  await emitTreeChanged({ directories: ['/ws'], complete: true });
  assert.equal(previewShown(), true);
  assert.equal(document.getElementById('preview-filename').textContent, '.env');
});

test('two quick switches cancel out: no redraw, and the last state is stored', async (t) => {
  const { tree, container, reads, prefWrites } = await mountHiddenTree(t);
  const readsBefore = reads.length;

  void tree.toggleHiddenFiles();
  await tree.toggleHiddenFiles();

  assert.deepEqual(topLabels(container), ['docs', 'README.md']);
  assert.equal(reads.length, readsBefore, 'the tree already matched, nothing was listed again');
  assert.deepEqual(prefWrites, [{ showHiddenFiles: false }, { showHiddenFiles: false }]);
  assert.equal(hiddenFilesItem().getAttribute('aria-checked'), 'false');
});

test('the stored switch at start-up is applied without being written back', async (t) => {
  const { tree, container, prefWrites } = await mountHiddenTree(t);

  await tree.setShowHiddenFiles(true, { persist: false });

  assert.deepEqual(topLabels(container), ['.github', 'docs', '.env', 'README.md']);
  assert.equal(hiddenFilesItem().getAttribute('aria-checked'), 'true');
  assert.deepEqual(prefWrites, []);
});

test('a hidden file opened from a link keeps its preview through a watcher report', async (t) => {
  const { fileViews, contexts } = await capturingViews();
  const { dom, container, emitTreeChanged } = await mountTree({}, { fileViews });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.deepEqual(await contexts[0].openFile('/ws/.hidden-notes.md'), { ok: true });

  await emitTreeChanged({ directories: ['/ws'], complete: true });
  assert.equal(document.getElementById('preview-filename').textContent, '.hidden-notes.md');
  assert.equal(previewShown(), true);
});

// ── Folder switches that overlap (#633) ─────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rowPaths = (container) => [...container.querySelectorAll('.tree-item')].map((row) => row.dataset.path);

/** The usual folder plus two more to switch to. */
function switchingFilesystem() {
  return {
    ...fakeFilesystem(),
    '/slow': [fileEntry('/slow', 'slow.txt')],
    '/other': [fileEntry('/other', 'other.txt')],
  };
}

test('an overtaken folder switch draws nothing and reports nothing (#633)', async (t) => {
  const listing = switchingFilesystem();
  const reported = [];
  const opened = [];
  const { dom, container, tree } = await mountTree({
    // A network share, say: the first folder takes its time to list.
    readDirectory: async (dir) => {
      if (dir === '/slow') await sleep(30);
      return { entries: listing[dir] ?? [], hidden: 0 };
    },
  }, {
    onWorkspaceChanged: (folder) => { reported.push(folder); },
    onProjectOpened: () => { opened.push(true); },
  });
  t.after(dom.cleanup);
  reported.length = 0;
  opened.length = 0;

  const first = tree.openProject('/slow');
  await sleep(5);
  const second = tree.openProject('/other');
  assert.deepEqual(await Promise.all([first, second]), [true, true]);

  assert.deepEqual(rowPaths(container), ['/other/other.txt'], 'only the folder opened last is drawn');
  assert.deepEqual(reported, ['/other'], 'and only it reaches the chat');
  assert.equal(opened.length, 1);
  assert.equal(document.getElementById('project-name').textContent, 'other');
});

test('a folder main refuses overtakes nothing: the switch before it still finishes (#633)', async (t) => {
  const listing = switchingFilesystem();
  const reported = [];
  const { dom, container, tree } = await mountTree({
    // Gone since it went into the history: main keeps the folder it had.
    activateFolder: async (folder) => ({ ok: folder !== '/gone' }),
    readDirectory: async (dir) => {
      if (dir === '/slow') await sleep(30);
      return { entries: listing[dir] ?? [], hidden: 0 };
    },
  }, { onWorkspaceChanged: (folder) => { reported.push(folder); } });
  t.after(dom.cleanup);
  reported.length = 0;

  const first = tree.openProject('/slow');
  await sleep(5);
  const second = tree.openProject('/gone');
  assert.deepEqual(await Promise.all([first, second]), [true, false]);

  assert.deepEqual(rowPaths(container), ['/slow/slow.txt']);
  assert.deepEqual(reported, ['/slow']);
});

test('a folder drawn while a newer activation still runs is never announced (#633)', async (t) => {
  const listing = switchingFilesystem();
  let mainRoot = '/ws';
  const reports = [];
  const { dom, container, tree } = await mountTree({
    // Main takes the new folder at once, but answers late.
    activateFolder: async (folder) => {
      mainRoot = folder;
      if (folder === '/other') await sleep(25);
      return { ok: true };
    },
    readDirectory: async (dir) => {
      if (dir === '/slow') await sleep(15);
      return { entries: listing[dir] ?? [], hidden: 0 };
    },
  }, {
    onWorkspaceChanged: async (folder) => {
      reports.push({ folder, mainRoot });
      await sleep(5);
    },
  });
  t.after(dom.cleanup);
  reports.length = 0;

  // /slow is listed before /other's activation answers.
  const first = tree.openProject('/slow');
  await sleep(5);
  const second = tree.openProject('/other');
  await Promise.all([first, second]);

  assert.deepEqual(reports, [{ folder: '/other', mainRoot: '/other' }], 'the chat hears only of the folder main is on');
  assert.deepEqual(rowPaths(container), ['/other/other.txt']);
});

test('a folder switch waits for the announcement still running before main switches (#633)', async (t) => {
  const listing = switchingFilesystem();
  const steps = [];
  const { dom, tree } = await mountTree({
    activateFolder: async (folder) => { steps.push(`activate ${folder}`); return { ok: true }; },
    readDirectory: async (dir) => ({ entries: listing[dir] ?? [], hidden: 0 }),
  }, {
    onWorkspaceChanged: async (folder) => {
      steps.push(`report ${folder}`);
      await sleep(30);
      steps.push(`reported ${folder}`);
    },
  });
  t.after(dom.cleanup);
  steps.length = 0;

  const first = tree.openProject('/slow');
  await until(() => steps.includes('report /slow'));
  const second = tree.openProject('/other');
  await Promise.all([first, second]);

  assert.deepEqual(steps, [
    'activate /slow', 'report /slow', 'reported /slow',
    'activate /other', 'report /other', 'reported /other',
  ], 'the chat reads the history of the folder it was told about');
});

test('the folder left goes at once, and a listing of it that hangs holds nothing up (#633)', async (t) => {
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  let releaseNew;
  const newGate = new Promise((resolve) => { releaseNew = resolve; });
  const listing = switchingFilesystem();
  let hang = false;
  const { dom, container, tree, emitTreeChanged } = await mountTree({
    readDirectory: async (dir) => {
      if (dir === '/ws' && hang) await oldGate;
      if (dir === '/other') await newGate;
      return { entries: listing[dir] ?? [], hidden: 0 };
    },
  });
  t.after(dom.cleanup);

  // A watcher report for /ws sits in the queue, its listing on a share that does not answer.
  hang = true;
  await emitTreeChanged({ directories: [], complete: false });

  const opening = tree.openProject('/other');
  await flush();
  await flush();
  assert.deepEqual(rowPaths(container), [], 'no row of /ws stays clickable under the new name');

  releaseNew();
  assert.equal(await opening, true, 'the new folder did not wait for the old listing');
  assert.deepEqual(rowPaths(container), ['/other/other.txt']);

  releaseOld();
  await flush();
  await flush();
  assert.deepEqual(rowPaths(container), ['/other/other.txt'], 'the late listing of /ws draws nothing');
});

test('a file that finishes opening after a folder switch is not selected (#633)', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const listing = switchingFilesystem();
  const { dom, container, tree, appStore } = await mountTree({
    readDirectory: async (dir) => ({ entries: listing[dir] ?? [], hidden: 0 }),
    readFile: async () => { await gate; return { content: '# Titel', size: 7 }; },
  });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  await tree.openProject('/other');
  release();
  await flush();
  await flush();

  assert.equal(appStore.selectedPath, null, 'README.md belongs to the folder left');
  assert.equal(appStore.activeTreeItem, null);
});

test('a link that resolves after a folder switch selects and opens nothing (#633)', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const listing = switchingFilesystem();
  const { fileViews, contexts } = await capturingViews();
  const { dom, container, tree, appStore } = await mountTree({
    readDirectory: async (dir) => {
      if (dir === '/ws/docs') await gate;
      return { entries: listing[dir] ?? [], hidden: 0 };
    },
  }, { fileViews });
  t.after(dom.cleanup);

  rowFor(container, '/ws/README.md').click();
  await flush();
  const following = contexts[0].openFile('/ws/docs/notes.md');
  await flush();
  await tree.openProject('/other');
  release();

  assert.deepEqual(await following, { ok: false, reason: 'stale' });
  assert.equal(appStore.selectedPath, null);
  assert.equal(document.getElementById('preview-filename').textContent === 'notes.md', false);
});

test('opening another folder lets go of the selection made in the one before (#633)', async (t) => {
  const listing = switchingFilesystem();
  const { dom, container, tree, appStore } = await mountTree({
    readDirectory: async (dir) => ({ entries: listing[dir] ?? [], hidden: 0 }),
  });
  t.after(dom.cleanup);
  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.equal(appStore.selectedPath, '/ws/README.md');

  assert.equal(await tree.openProject('/other'), true);
  assert.equal(appStore.selectedPath, null, 'the next question must not name a file of /ws');
  assert.equal(appStore.selectedIsDirectory, false);
  assert.equal(appStore.activeTreeItem, null);
});

// ── One queue for every rebuild (#636) ──────────────────────────────────────

test('two writes in one folder at once draw every entry once (#636)', async (t) => {
  const { dom, container, tree, entries } = await mountTree();
  t.after(dom.cleanup);
  entries['/ws'] = [...entries['/ws'], fileEntry('/ws', 'neu.txt')];

  // One apply_patch with two files: ChatStream does not wait in between.
  await Promise.all([tree.notifyExternalFileWrite('neu.txt'), tree.notifyExternalFileWrite('README.md')]);

  assert.deepEqual(rowPaths(container), ['/ws/docs', '/ws/README.md', '/ws/neu.txt']);
  assert.equal(container.querySelectorAll('.tree-children[data-path="/ws/docs"]').length, 1);
});

test('a second click on a folder that is still loading waits for that load (#636)', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const listing = fakeFilesystem();
  const reads = [];
  const { dom, container } = await mountTree({
    readDirectory: async (dir) => {
      reads.push(dir);
      if (dir === '/ws/docs') await gate;
      return { entries: listing[dir] ?? [], hidden: 0 };
    },
  });
  t.after(dom.cleanup);

  rowFor(container, '/ws/docs').click();
  rowFor(container, '/ws/docs').click();
  await flush();
  release();
  await until(() => rowFor(container, '/ws/docs').getAttribute('aria-busy') === null);

  const children = container.querySelector('.tree-children[data-path="/ws/docs"]');
  assert.deepEqual(rowPaths(children), ['/ws/docs/notes.md'], 'one row per child');
  assert.equal(reads.filter((dir) => dir === '/ws/docs').length, 1, 'listed once');
  assert.ok(children.classList.contains('expanded'));
});

/**
 * README.md selected, the focus on its @ button, the tree scrolled — and a
 * `b.txt` next to it that the test writes, deletes or moves.
 */
async function mountFocusedTree(t) {
  const listing = fakeFilesystem();
  listing['/ws'] = [...listing['/ws'], fileEntry('/ws', 'b.txt')];
  let deletedListener = null;
  const mounted = await mountTree({
    readDirectory: async (dir) => ({ entries: listing[dir] ?? [], hidden: 0 }),
    moveItem: async (source, dest) => {
      const from = source.slice(0, source.lastIndexOf('/'));
      const item = listing[from].find((entry) => entry.path === source);
      listing[from] = listing[from].filter((entry) => entry !== item);
      listing[dest] = [...(listing[dest] ?? []), { ...item, path: `${dest}/${item.name}` }];
      return {};
    },
    onFsItemDeleted: (callback) => { deletedListener = callback; },
  }, { insertChatReference() {} });
  t.after(mounted.dom.cleanup);

  const { container, appStore } = mounted;
  rowFor(container, '/ws/README.md').click();
  await flush();
  assert.equal(appStore.selectedPath, '/ws/README.md');
  rowFor(container, '/ws/README.md').querySelector('.tree-item-reference').focus();
  container.scrollTop = 42;
  return { ...mounted, listing, deleted: (payload) => deletedListener(payload) };
}

/** Until the root is drawn again without b.txt where it was. */
const rootRedrawnWithout = (container, path) =>
  until(() => rowFor(container, '/ws/README.md') && !rowFor(container, path));

const viewKeepingChanges = {
  'an agent write': async ({ tree, listing }) => {
    listing['/ws'] = [...listing['/ws'], fileEntry('/ws', 'neu.txt')];
    await tree.notifyExternalFileWrite('neu.txt');
  },
  'a delete from the context menu': async ({ container, listing, deleted }) => {
    listing['/ws'] = listing['/ws'].filter((item) => item.name !== 'b.txt');
    deleted({ path: '/ws/b.txt' });
    await rootRedrawnWithout(container, '/ws/b.txt');
  },
  'a move in the tree': async ({ container, calls }) => {
    const dataTransfer = createDataTransfer();
    dispatchDragEvent(rowFor(container, '/ws/b.txt'), 'dragstart', { dataTransfer });
    dispatchDragEvent(rowFor(container, '/ws/docs'), 'drop', { dataTransfer });
    await rootRedrawnWithout(container, '/ws/b.txt');
    assert.deepEqual(calls.moveItem, [], 'the fake above stands in for the recording one');
  },
};

for (const [what, change] of Object.entries(viewKeepingChanges)) {
  test(`selection, focus and scroll survive ${what} (#636)`, async (t) => {
    const mounted = await mountFocusedTree(t);
    await change(mounted);
    await flush();

    const { container, appStore } = mounted;
    const row = rowFor(container, '/ws/README.md');
    assert.ok(row.classList.contains('active'), 'the selection stays highlighted');
    assert.equal(appStore.activeTreeItem, row, 'and points at the new node');
    assert.equal(
      document.activeElement,
      row.querySelector('.tree-item-reference'),
      'the focus stays on the same place of the new row'
    );
    assert.equal(container.scrollTop, 42);
  });
}

// ── States of the tree (#639) ───────────────────────────────────────────────

test('a file row keeps the arrow slot, so names of one level line up (#639)', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);

  const arrow = rowFor(container, '/ws/README.md').querySelector('.arrow');
  assert.ok(arrow.classList.contains('arrow--placeholder'));
  // The global `hidden` is `display: none !important` and takes the slot along.
  assert.equal(arrow.classList.contains('hidden'), false);
  // Measured with the real stylesheet in e2e/hidden-files.test.mjs.
});

test('a folder that cannot be read says so in its place, in both languages (#639)', async (t) => {
  const listing = fakeFilesystem();
  const { dom, container } = await mountTree({
    readDirectory: async (dir) => (dir === '/ws/docs'
      ? { entries: [], hidden: 0, unreadable: 'permission' }
      : { entries: listing[dir] ?? [], hidden: 0 }),
  });
  t.after(dom.cleanup);

  rowFor(container, '/ws/docs').click();
  await until(() => container.querySelector('.tree-unreadable'));

  const children = container.querySelector('.tree-children[data-path="/ws/docs"]');
  const note = children.querySelector(':scope > .tree-unreadable');
  assert.ok(note, 'in the folder, where its entries would be');
  assert.ok(children.classList.contains('expanded'));
  assert.equal(note.textContent, 'No permission to read this folder');
  assert.equal(note.classList.contains('tree-item'), false, 'not an entry: no keyboard stop, no drag');
  assert.equal(note.style.paddingLeft, '56px', 'lined up with the names one level in');

  const { setLocale } = await importRenderer('i18n.js');
  setLocale('de', { force: true });
  t.after(() => setLocale('en', { force: true }));
  assert.equal(note.textContent, 'Keine Berechtigung, diesen Ordner zu lesen');
});

test('an unreadable project folder says why, and follows a changed reason (#639)', async (t) => {
  let reason = 'missing';
  const { dom, container, emitTreeChanged } = await mountTree({
    readDirectory: async () => ({ entries: [], hidden: 0, unreadable: reason }),
  });
  t.after(dom.cleanup);
  const note = () => container.querySelector(':scope > .tree-unreadable');

  assert.equal(note()?.textContent, 'This folder no longer exists', 'not an empty tree without a word');
  assert.equal(note().style.paddingLeft, '40px');

  // No rows before and after: only the reason tells the listings apart.
  reason = 'refused';
  await emitTreeChanged({ directories: ['/ws'], complete: true });
  assert.equal(note()?.textContent, 'This folder could not be read', 'a reason without words of its own');
});

test('a folder that takes its time shows that it is loading, a quick one does not (#639)', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const listing = fakeFilesystem();
  const { dom, container } = await mountTree({
    readDirectory: async (dir) => {
      if (dir === '/ws/docs') await gate;
      return { entries: listing[dir] ?? [], hidden: 0 };
    },
  });
  t.after(dom.cleanup);
  const row = rowFor(container, '/ws/docs');

  row.click();
  await flush();
  assert.equal(row.getAttribute('aria-busy'), 'true', 'busy from the click on');
  assert.ok(row.querySelector('.arrow').classList.contains('expanded'), 'the arrow turns at once');
  assert.equal(row.classList.contains('tree-item--loading'), false, 'nothing to see within the delay');

  await sleep(200);
  assert.ok(row.classList.contains('tree-item--loading'), 'past the delay the row shows it');

  release();
  await until(() => row.getAttribute('aria-busy') === null);
  assert.equal(row.classList.contains('tree-item--loading'), false);
  assert.ok(container.querySelector('.tree-children[data-path="/ws/docs"]').classList.contains('expanded'));
});

/** A tree whose `/slow` listing waits until the test lets it go. */
async function mountWithHeldBackRoot(t) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const listing = switchingFilesystem();
  const mounted = await mountTree({
    readDirectory: async (dir) => {
      if (dir === '/slow') await gate;
      return { entries: listing[dir] ?? [], hidden: 0 };
    },
  });
  t.after(mounted.dom.cleanup);
  return { ...mounted, release };
}

const loadingNote = (container) => container.querySelector(':scope > .tree-loading');

test('a project folder that takes its time to list says so in the tree (#639)', async (t) => {
  const { container, tree, release } = await mountWithHeldBackRoot(t);

  const opening = tree.openProject('/slow');
  await flush();
  assert.equal(container.getAttribute('aria-busy'), 'true', 'busy at once');
  assert.equal(loadingNote(container), null, 'nothing to see within the delay');

  await sleep(200);
  const note = loadingNote(container);
  assert.ok(note, 'past the delay a note stands in the tree');
  assert.equal(note.textContent, 'Loading folder…');
  assert.equal(note.classList.contains('tree-item'), false, 'not an entry');
  assert.ok(note.querySelector('.tree-loading-ring'), 'with the ring of a loading folder');

  const { setLocale } = await importRenderer('i18n.js');
  setLocale('de', { force: true });
  t.after(() => setLocale('en', { force: true }));
  assert.equal(note.textContent, 'Ordner wird geladen…');
  setLocale('en', { force: true });

  release();
  assert.equal(await opening, true);
  assert.equal(loadingNote(container), null, 'gone once the rows are there');
  assert.equal(container.hasAttribute('aria-busy'), false);
  assert.deepEqual(rowPaths(container), ['/slow/slow.txt']);
});

test('an overtaken switch takes its loading note along and holds nothing up (#633, #639)', async (t) => {
  const { container, tree, release } = await mountWithHeldBackRoot(t);

  const first = tree.openProject('/slow');
  await sleep(200);
  assert.ok(loadingNote(container), 'the share does not answer');

  // The listing of /slow never came: the next folder must not wait for it.
  assert.equal(await tree.openProject('/other'), true);
  assert.equal(await first, true);
  assert.deepEqual(rowPaths(container), ['/other/other.txt']);
  assert.equal(loadingNote(container), null);
  assert.equal(container.hasAttribute('aria-busy'), false);

  release();
  await flush();
  assert.deepEqual(rowPaths(container), ['/other/other.txt'], 'the late listing is stale and not drawn');
});

test('a quick listing never shows the loading state (#639)', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);
  const row = rowFor(container, '/ws/docs');

  row.click();
  await flush();
  await sleep(200);
  assert.equal(row.classList.contains('tree-item--loading'), false, 'the timer went with the listing');
  assert.equal(row.hasAttribute('aria-busy'), false);
});

// ── File tree details (#641) ────────────────────────────────────────────────

test('text dropped on a folder row moves nothing; only a drag from the tree does (#641)', async (t) => {
  const { dom, container, calls } = await mountTree();
  t.after(dom.cleanup);

  // Reads like a path of the workspace, but comes from a text editor.
  const dataTransfer = createDataTransfer({ data: { 'text/plain': '/ws/README.md' } });
  const over = dispatchDragEvent(rowFor(container, '/ws/docs'), 'dragover', { dataTransfer });
  assert.equal(over.defaultPrevented, false, 'the row does not offer itself as a target');
  dispatchDragEvent(rowFor(container, '/ws/docs'), 'dragenter', { dataTransfer });
  assert.equal(rowFor(container, '/ws/docs').classList.contains('drop-target'), false);

  dispatchDragEvent(rowFor(container, '/ws/docs'), 'drop', { dataTransfer });
  await flush();
  assert.deepEqual(calls.moveItem, []);
});

test('an agent write to a dot path reaches its row and its preview (#641)', async (t) => {
  let content = 'A=1';
  const { dom, container, tree, entries } = await mountTree({
    readFile: async () => ({ content, size: content.length }),
  });
  t.after(dom.cleanup);
  entries['/ws'] = [
    { name: '.github', path: '/ws/.github', isDirectory: true },
    ...entries['/ws'],
    fileEntry('/ws', '.env'),
  ];
  entries['/ws/.github'] = [];
  await tree.notifyExternalFileWrite('.env');
  rowFor(container, '/ws/.env').click();
  await flush();
  assert.equal(paneText(), 'A=1');

  content = 'A=2';
  await tree.notifyExternalFileWrite('.env');
  assert.equal(paneText(), 'A=2', '.env, not env');

  rowFor(container, '/ws/.github').click();
  await until(() => container.querySelector('.tree-children[data-path="/ws/.github"].expanded'));
  entries['/ws/.github'] = [fileEntry('/ws/.github', 'ci.yml')];
  await tree.notifyExternalFileWrite('./.github/ci.yml');
  assert.ok(rowFor(container, '/ws/.github/ci.yml'), '.github/, not github/');
});

test('every row carries its full name as a tooltip, for a name cut off deep in the tree (#641)', async (t) => {
  const { dom, container } = await mountTree();
  t.after(dom.cleanup);

  assert.equal(rowFor(container, '/ws/README.md').title, 'README.md');
  assert.equal(rowFor(container, '/ws/docs').title, 'docs');
});
