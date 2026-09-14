const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Issue #56: Umrechnung eines Baum-Eintrags (nativer absoluter Pfad) in die
 * @-Referenz der Chat-Eingabe, plus die Nutzlast des eigenen Drag-MIME-Typs.
 */
const modulePromise = import(
  pathToFileURL(
    path.join(__dirname, '..', 'src', 'renderer', 'chat', 'workspaceReference.js')
  ).href
);

test('workspaceReferenceFor rechnet POSIX-Pfade relativ zur Wurzel', async () => {
  const { workspaceReferenceFor } = await modulePromise;

  assert.deepEqual(workspaceReferenceFor('/Users/k/projekt/docs/release.md', '/Users/k/projekt'), {
    path: 'docs/release.md',
    kind: 'file',
  });
  assert.deepEqual(
    workspaceReferenceFor('/Users/k/projekt/src', '/Users/k/projekt', { isDirectory: true }),
    { path: 'src', kind: 'directory' }
  );
});

test('workspaceReferenceFor kommt mit Windows-Trennern klar', async () => {
  const { workspaceReferenceFor } = await modulePromise;

  // Der Main-Prozess liefert unter Windows Backslashes, die Referenz bleibt POSIX.
  assert.deepEqual(workspaceReferenceFor('C:\\repo\\src\\app.js', 'C:\\repo'), {
    path: 'src/app.js',
    kind: 'file',
  });
  // Gemischte Trenner und ein Schrägstrich am Ende der Wurzel ändern nichts.
  assert.deepEqual(workspaceReferenceFor('C:\\repo/src\\app.js', 'C:\\repo\\'), {
    path: 'src/app.js',
    kind: 'file',
  });
  assert.deepEqual(workspaceReferenceFor('/Users/k/projekt//docs/a.md', '/Users/k/projekt/'), {
    path: 'docs/a.md',
    kind: 'file',
  });
});

test('workspaceReferenceFor ignoriert alles außerhalb des Workspace', async () => {
  const { workspaceReferenceFor } = await modulePromise;

  assert.equal(workspaceReferenceFor('/Users/k/anderes/a.md', '/Users/k/projekt'), null);
  // Namens-Präfix ist keine Enthaltensein: „projekt-alt“ liegt nicht in „projekt“.
  assert.equal(workspaceReferenceFor('/Users/k/projekt-alt/a.md', '/Users/k/projekt'), null);
  // Die Wurzel selbst hat keine relative Schreibweise.
  assert.equal(workspaceReferenceFor('/Users/k/projekt', '/Users/k/projekt'), null);
  assert.equal(workspaceReferenceFor('/Users/k/projekt/a.md', ''), null);
  assert.equal(workspaceReferenceFor(null, '/Users/k/projekt'), null);
  assert.equal(workspaceReferenceFor('/Users/k/projekt/a.md', null), null);
});

test('Drag-Nutzlast überlebt encode/decode', async () => {
  const { encodeTreeDragPayload, decodeTreeDragPayload, TREE_DRAG_MIME } = await modulePromise;

  assert.equal(TREE_DRAG_MIME, 'application/x-snotra-path');
  const raw = encodeTreeDragPayload({ path: '/Users/k/projekt/src', isDirectory: true });
  assert.deepEqual(decodeTreeDragPayload(raw), { path: '/Users/k/projekt/src', isDirectory: true });
  assert.deepEqual(decodeTreeDragPayload(encodeTreeDragPayload({ path: 'C:\\repo\\a.js' })), {
    path: 'C:\\repo\\a.js',
    isDirectory: false,
  });
});

test('decodeTreeDragPayload lehnt fremde Nutzlast ab', async () => {
  const { decodeTreeDragPayload } = await modulePromise;

  // Kein Drag aus dem Baum: der Drop soll dann gar nicht abgefangen werden.
  assert.equal(decodeTreeDragPayload(''), null);
  assert.equal(decodeTreeDragPayload(undefined), null);
  assert.equal(decodeTreeDragPayload('/Users/k/projekt/a.md'), null);
  assert.equal(decodeTreeDragPayload('{"isDirectory":true}'), null);
  assert.equal(decodeTreeDragPayload('{"path":""}'), null);
});
