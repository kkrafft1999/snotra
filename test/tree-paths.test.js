const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Pfad- und Baumlogik des Dateibaums (src/renderer/tree/treePaths.js).
 *
 * Bis Issue #81 lagen diese Entscheidungen als exportierte Funktionen mitten
 * in FileTree.js (tausend Zeilen DOM-Verdrahtung). Seitdem sind sie ein
 * eigenes Modul — DOM-frei, ohne Zustand, hier einzeln geprüft. Die
 * Verdrahtung selbst prüft test/file-tree-dom.test.js am echten DOM (#78).
 */
const treePathsPromise = import(
  pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'tree', 'treePaths.js')).href
);

test('isExternalFileDrop erkennt einen Drag aus dem Betriebssystem', async () => {
  const { isExternalFileDrop } = await treePathsPromise;
  assert.equal(isExternalFileDrop(['Files'], false), true);
  assert.equal(isExternalFileDrop(['text/plain', 'Files'], false), true);
  // DOMStringList statt Array — das liefert das echte DataTransfer.
  assert.equal(isExternalFileDrop({ length: 1, 0: 'Files' }, false), true);
});

test('isExternalFileDrop lässt das interne Verschieben unberührt', async () => {
  const { isExternalFileDrop } = await treePathsPromise;
  // Ein laufender Drag aus dem Baum schlägt den Import aus, auch wenn das
  // DataTransfer „Files“ meldet — sonst würde ein Verschieben zum Import.
  assert.equal(isExternalFileDrop(['Files'], true), false);
  assert.equal(isExternalFileDrop(['text/plain'], false), false);
  assert.equal(isExternalFileDrop(undefined, false), false);
  assert.equal(isExternalFileDrop([], false), false);
});

test('isExternalFileDrop erkennt den Baum-Drag am eigenen MIME-Typ', async () => {
  const { isExternalFileDrop } = await treePathsPromise;
  // Issue #56: Der eigene Typ verraet den internen Drag auch dann, wenn der
  // Modulzustand ihn nicht kennt — etwa nach Verlassen und Wiederbetreten.
  assert.equal(isExternalFileDrop(['application/x-snotra-path'], false), false);
  assert.equal(isExternalFileDrop(['application/x-snotra-path', 'Files'], false), false);
  assert.equal(
    isExternalFileDrop({ length: 2, 0: 'text/plain', 1: 'application/x-snotra-path' }, false),
    false
  );
});

test('importDestDirFor wählt die Ordnerzeile unter dem Zeiger', async () => {
  const { importDestDirFor } = await treePathsPromise;
  const root = path.join('/Users', 'k', 'projekt');
  const sub = path.join(root, 'docs');
  assert.equal(importDestDirFor({ isDirectory: 'true', path: sub }, root), sub);
});

test('importDestDirFor fällt auf den Projektordner zurück', async () => {
  const { importDestDirFor } = await treePathsPromise;
  const root = path.join('/Users', 'k', 'projekt');
  // Freie Fläche, Dateizeile, Ordnerzeile ohne Pfad: immer der Root.
  assert.equal(importDestDirFor(null, root), root);
  assert.equal(importDestDirFor({ isDirectory: 'false', path: path.join(root, 'a.txt') }, root), root);
  assert.equal(importDestDirFor({ isDirectory: 'true' }, root), root);
});

test('importDestDirFor liefert ohne geöffneten Projektordner kein Ziel', async () => {
  const { importDestDirFor } = await treePathsPromise;
  assert.equal(importDestDirFor({ isDirectory: 'true', path: '/irgendwo' }, null), null);
  assert.equal(importDestDirFor(null, ''), null);
});

test('sortFoldersTopDown bringt Elternordner vor ihre Kinder', async () => {
  const { sortFoldersTopDown } = await treePathsPromise;
  // Ein Kind vor seinem Elternordner fände dessen Container noch nicht.
  assert.deepEqual(
    sortFoldersTopDown(['/ws/a/b/c', '/ws', '/ws/a/b', '/ws/a']),
    ['/ws', '/ws/a', '/ws/a/b', '/ws/a/b/c']
  );
  assert.deepEqual(
    sortFoldersTopDown(['C:\\r\\a\\b', 'C:\\r', 'C:\\r\\a']),
    ['C:\\r', 'C:\\r\\a', 'C:\\r\\a\\b']
  );
});

test('sortFoldersTopDown wirft Doppelte und Leeres weg', async () => {
  const { sortFoldersTopDown } = await treePathsPromise;
  assert.deepEqual(sortFoldersTopDown(['/ws/a', '/ws', '/ws/a']), ['/ws', '/ws/a']);
  assert.deepEqual(sortFoldersTopDown(['/ws', '', null, undefined]), ['/ws']);
  assert.deepEqual(sortFoldersTopDown(undefined), []);
});

test('treeDepthFromIndentWidth rechnet die Einrückung in die Baumtiefe zurück', async () => {
  const { treeDepthFromIndentWidth } = await treePathsPromise;
  // 16 px je Ebene; die Kinder einer Zeile stehen eine Ebene tiefer.
  assert.equal(treeDepthFromIndentWidth('4px'), 1);
  assert.equal(treeDepthFromIndentWidth('16px'), 2);
  assert.equal(treeDepthFromIndentWidth('32px'), 3);
  // Ohne gesetzte Breite (leerer style) bleibt es bei der obersten Ebene.
  assert.equal(treeDepthFromIndentWidth(''), 1);
  assert.equal(treeDepthFromIndentWidth(undefined), 1);
  assert.equal(treeDepthFromIndentWidth('auto'), 1);
});

test('listingSignature unterscheidet Ordner und Dateien am selben Pfad', async () => {
  const { listingSignature } = await treePathsPromise;
  assert.equal(listingSignature('/ws/docs', true), 'd:/ws/docs');
  assert.equal(listingSignature('/ws/docs', false), 'f:/ws/docs');
  assert.notEqual(listingSignature('/ws/x', true), listingSignature('/ws/x', false));
});

test('listingsDiffer meldet nur echte Unterschiede im Ordnerinhalt', async () => {
  const { listingsDiffer } = await treePathsPromise;
  assert.equal(listingsDiffer(['f:/ws/a', 'f:/ws/b'], ['f:/ws/a', 'f:/ws/b']), false);
  // Neuer Eintrag, weggefallener Eintrag, andere Reihenfolge: alles ein Unterschied.
  assert.equal(listingsDiffer(['f:/ws/a', 'f:/ws/b'], ['f:/ws/a']), true);
  assert.equal(listingsDiffer(['f:/ws/a'], ['f:/ws/a', 'f:/ws/b']), true);
  assert.equal(listingsDiffer(['f:/ws/b', 'f:/ws/a'], ['f:/ws/a', 'f:/ws/b']), true);
  assert.equal(listingsDiffer([], []), false);
});

test('foldersToCheck prüft bei vollständiger Meldung nur die gemeldeten Ordner', async () => {
  const { foldersToCheck } = await treePathsPromise;
  const visible = ['/ws', '/ws/docs', '/ws/src'];
  assert.deepEqual(
    foldersToCheck({ visible, reported: ['/ws/docs', '/ws/weg'], complete: true }),
    ['/ws/docs']
  );
  assert.deepEqual(foldersToCheck({ visible, reported: [], complete: true }), []);
});

test('foldersToCheck prüft bei unvollständiger Meldung alles Sichtbare', async () => {
  const { foldersToCheck } = await treePathsPromise;
  const visible = ['/ws', '/ws/docs'];
  // Zweigwechsel: der Watcher weiß nicht mehr, welche Ordner es betrifft.
  assert.deepEqual(foldersToCheck({ visible, reported: [], complete: false }), visible);
  assert.deepEqual(foldersToCheck(), []);
});

test('foldersToReexpand nennt die aufgeklappten Kinder neu gezeichneter Ordner', async () => {
  const { foldersToReexpand } = await treePathsPromise;
  assert.deepEqual(
    foldersToReexpand({
      expandedBefore: ['/ws/src', '/ws/src/tief', '/ws/docs'],
      redrawn: ['/ws/src'],
      rootPath: '/ws',
    }),
    ['/ws/src/tief']
  );
});

test('foldersToReexpand lässt Projektordner und die gezeichneten Ordner selbst weg', async () => {
  const { foldersToReexpand } = await treePathsPromise;
  // Der Projektordner ist immer offen, die neu gezeichneten bringt refreshFolder mit.
  assert.deepEqual(
    foldersToReexpand({
      expandedBefore: ['/ws', '/ws/src'],
      redrawn: ['/ws/src'],
      rootPath: '/ws',
    }),
    []
  );
  assert.deepEqual(foldersToReexpand(), []);
});

test('foldersToReexpand zerlegt auch Windows-Pfade richtig', async () => {
  const { foldersToReexpand } = await treePathsPromise;
  assert.deepEqual(
    foldersToReexpand({
      expandedBefore: ['C:\\ws\\src\\tief', 'C:\\ws\\docs'],
      redrawn: ['C:\\ws\\src'],
      rootPath: 'C:\\ws',
    }),
    ['C:\\ws\\src\\tief']
  );
});

test('isHiddenTreePath: a dot entry and everything below a dot folder (#436)', async () => {
  const { isHiddenTreePath } = await treePathsPromise;
  assert.equal(isHiddenTreePath('/ws/.gitignore', '/ws'), true);
  assert.equal(isHiddenTreePath('/ws/.github', '/ws'), true);
  assert.equal(isHiddenTreePath('/ws/.github/workflows/ci.yml', '/ws'), true);
  assert.equal(isHiddenTreePath('/ws/src/.eslintrc', '/ws'), true);
  assert.equal(isHiddenTreePath('/ws/src/app.js', '/ws'), false);
  // A dot inside a name is no hidden entry.
  assert.equal(isHiddenTreePath('/ws/v1.2/notes.md', '/ws'), false);
});

test('isHiddenTreePath: only the part below the project folder counts (#436)', async () => {
  const { isHiddenTreePath } = await treePathsPromise;
  // A project that itself lives in a dot folder is not hidden from its tree.
  assert.equal(isHiddenTreePath('/home/me/.config/tool/src/a.js', '/home/me/.config/tool'), false);
  assert.equal(isHiddenTreePath('/home/me/.config/tool/.env', '/home/me/.config/tool'), true);
  // The root itself and paths outside it are never "hidden".
  assert.equal(isHiddenTreePath('/ws', '/ws'), false);
  assert.equal(isHiddenTreePath('/other/.env', '/ws'), false);
  assert.equal(isHiddenTreePath('/ws/.env', null), false);
});

test('isHiddenTreePath takes Windows paths apart as well (#436)', async () => {
  const { isHiddenTreePath } = await treePathsPromise;
  assert.equal(isHiddenTreePath('C:\\ws\\.github\\workflows', 'C:\\ws'), true);
  assert.equal(isHiddenTreePath('C:\\ws\\src\\app.js', 'C:\\ws'), false);
  assert.equal(isHiddenTreePath('C:\\Users\\me\\.vscode\\proj\\src', 'C:\\Users\\me\\.vscode\\proj'), false);
  // A project at the root of a drive.
  assert.equal(isHiddenTreePath('D:\\.env', 'D:\\'), true);
});
