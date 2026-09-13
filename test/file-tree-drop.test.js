const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Issue #101: Erkennung und Zielwahl für den Drop von außen. Es gibt keinen
 * DOM-Test-Stack (#78), deshalb exportiert FileTree.js die Entscheidungslogik
 * DOM-frei — wie schon folderDepthSortKey und parentDirFromItemPath (#73).
 */
const fileTreePromise = import(
  pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'components', 'FileTree.js')).href
);

test('isExternalFileDrop erkennt einen Drag aus dem Betriebssystem', async () => {
  const { isExternalFileDrop } = await fileTreePromise;
  assert.equal(isExternalFileDrop(['Files'], false), true);
  assert.equal(isExternalFileDrop(['text/plain', 'Files'], false), true);
  // DOMStringList statt Array — das liefert das echte DataTransfer.
  assert.equal(isExternalFileDrop({ length: 1, 0: 'Files' }, false), true);
});

test('isExternalFileDrop lässt das interne Verschieben unberührt', async () => {
  const { isExternalFileDrop } = await fileTreePromise;
  // Ein laufender Drag aus dem Baum schlägt den Import aus, auch wenn das
  // DataTransfer „Files“ meldet — sonst würde ein Verschieben zum Import.
  assert.equal(isExternalFileDrop(['Files'], true), false);
  assert.equal(isExternalFileDrop(['text/plain'], false), false);
  assert.equal(isExternalFileDrop(undefined, false), false);
  assert.equal(isExternalFileDrop([], false), false);
});

test('importDestDirFor wählt die Ordnerzeile unter dem Zeiger', async () => {
  const { importDestDirFor } = await fileTreePromise;
  const root = path.join('/Users', 'k', 'projekt');
  const sub = path.join(root, 'docs');
  assert.equal(importDestDirFor({ isDirectory: 'true', path: sub }, root), sub);
});

test('importDestDirFor fällt auf den Projektordner zurück', async () => {
  const { importDestDirFor } = await fileTreePromise;
  const root = path.join('/Users', 'k', 'projekt');
  // Freie Fläche, Dateizeile, Ordnerzeile ohne Pfad: immer der Root.
  assert.equal(importDestDirFor(null, root), root);
  assert.equal(importDestDirFor({ isDirectory: 'false', path: path.join(root, 'a.txt') }, root), root);
  assert.equal(importDestDirFor({ isDirectory: 'true' }, root), root);
});

test('importDestDirFor liefert ohne geöffneten Projektordner kein Ziel', async () => {
  const { importDestDirFor } = await fileTreePromise;
  assert.equal(importDestDirFor({ isDirectory: 'true', path: '/irgendwo' }, null), null);
  assert.equal(importDestDirFor(null, ''), null);
});
