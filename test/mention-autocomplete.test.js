const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Das Renderer-Modul ist natives ESM ohne Bundler; Node erkennt die Syntax beim
// dynamischen Import und braucht dafür kein "type": "module" in der package.json.
const modulePromise = import(
  pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'chat', 'mentionAutocomplete.js')).href
);

const ENTRIES = [
  { path: 'README.md', kind: 'file' },
  { path: 'package.json', kind: 'file' },
  { path: 'docs', kind: 'directory' },
  { path: 'src', kind: 'directory' },
  { path: 'docs/roadmap.md', kind: 'file' },
  { path: 'docs/task.md', kind: 'file' },
  { path: 'src/main', kind: 'directory' },
  { path: 'src/main/index.js', kind: 'file' },
  { path: 'src/renderer/roadmap-tool.js', kind: 'file' },
  { path: 'dmap.txt', kind: 'file' },
];

test('findMentionQuery finds the open reference in front of the caret', async () => {
  const { findMentionQuery } = await modulePromise;

  assert.deepEqual(findMentionQuery('Schau in @doc', 13), { start: 9, query: 'doc' });
  assert.deepEqual(findMentionQuery('@', 1), { start: 0, query: '' });
  assert.deepEqual(findMentionQuery('siehe (@src', 11), { start: 7, query: 'src' });
  assert.deepEqual(findMentionQuery('„@docs', 6), { start: 1, query: 'docs' });
});

test('findMentionQuery respects the caret position', async () => {
  const { findMentionQuery } = await modulePromise;

  assert.deepEqual(findMentionQuery('@docs/roadmap.md', 5), { start: 0, query: 'docs' });
  assert.deepEqual(findMentionQuery('@docs/roadmap.md und @sr', 24), { start: 21, query: 'sr' });
  // Ohne Cursorangabe gilt das Textende.
  assert.deepEqual(findMentionQuery('lies @README', undefined), { start: 5, query: 'README' });
});

test('findMentionQuery ignores closed references, e-mail addresses and plain text', async () => {
  const { findMentionQuery } = await modulePromise;

  assert.equal(findMentionQuery('@docs/roadmap.md und', 20), null, 'Leerraum schließt die Referenz');
  assert.equal(findMentionQuery('mail an foo@bar', 15), null, 'kein @ mitten im Wort');
  assert.equal(findMentionQuery('kein Verweis', 12), null);
  assert.equal(findMentionQuery('', 0), null);
  assert.equal(findMentionQuery(null, 0), null);
});

test('filterMentionCandidates keeps the delivered order for an empty query', async () => {
  const { filterMentionCandidates } = await modulePromise;

  const out = filterMentionCandidates(ENTRIES, '', 3);
  assert.deepEqual(out.map((e) => e.path), ['README.md', 'package.json', 'docs']);
});

test('filterMentionCandidates ranks basename prefix before path prefix, substring and subsequence', async () => {
  const { filterMentionCandidates } = await modulePromise;

  const road = filterMentionCandidates(ENTRIES, 'road').map((e) => e.path);
  assert.deepEqual(road, ['docs/roadmap.md', 'src/renderer/roadmap-tool.js']);

  // "dmap": exakter Dateiname vor bloßer Teilzeichenkette vor Buchstabenfolge.
  const dmap = filterMentionCandidates(ENTRIES, 'dmap').map((e) => e.path);
  assert.equal(dmap[0], 'dmap.txt');
  assert.ok(dmap.includes('docs/roadmap.md'), 'Teilzeichenkette "dmap" in roadmap');
  assert.ok(dmap.includes('src/renderer/roadmap-tool.js'));

  // Pfad-Präfix mit „/“ filtert auf den Ordnerinhalt (der Ordner selbst fällt raus).
  const docs = filterMentionCandidates(ENTRIES, 'docs/').map((e) => e.path);
  assert.deepEqual(docs, ['docs/task.md', 'docs/roadmap.md']);
});

test('filterMentionCandidates is case-insensitive, matches subsequences and honors the limit', async () => {
  const { filterMentionCandidates } = await modulePromise;

  assert.deepEqual(
    filterMentionCandidates(ENTRIES, 'readme').map((e) => e.path),
    ['README.md']
  );
  // r-d-m-p in Reihenfolge: roadmap.md, roadmap-tool.js
  const fuzzy = filterMentionCandidates(ENTRIES, 'rdmp').map((e) => e.path);
  assert.deepEqual(fuzzy, ['docs/roadmap.md', 'src/renderer/roadmap-tool.js']);

  assert.equal(filterMentionCandidates(ENTRIES, 'a', 2).length, 2);
  assert.deepEqual(filterMentionCandidates(ENTRIES, 'zzz'), []);
  assert.deepEqual(filterMentionCandidates(null, 'x'), []);
});

test('applyMention inserts the relative path with a trailing space for files', async () => {
  const { applyMention } = await modulePromise;

  const out = applyMention('Schau in @doc', 9, 13, { path: 'docs/roadmap.md', kind: 'file' });
  assert.equal(out.text, 'Schau in @docs/roadmap.md ');
  assert.equal(out.caret, out.text.length);
});

test('applyMention keeps directories open with a trailing slash', async () => {
  const { applyMention } = await modulePromise;

  const out = applyMention('@sr', 0, 3, { path: 'src', kind: 'directory' });
  assert.equal(out.text, '@src/');
  assert.equal(out.caret, 5);
});

test('applyMention preserves the text behind the caret and reuses an existing space', async () => {
  const { applyMention } = await modulePromise;

  const mid = applyMention('lies @doc bitte', 5, 9, { path: 'docs/task.md', kind: 'file' });
  assert.equal(mid.text, 'lies @docs/task.md bitte');
  assert.equal(mid.caret, 'lies @docs/task.md '.length);

  const noSpace = applyMention('lies @docbitte', 5, 9, { path: 'docs/task.md', kind: 'file' });
  assert.equal(noSpace.text, 'lies @docs/task.md bitte');
});

test('insertReferenceAt fügt ohne getippte Abfrage an der Cursorposition ein', async () => {
  const { insertReferenceAt } = await modulePromise;

  // Leeres Feld und nach einem Leerzeichen: nichts davor nötig (Issue #56).
  assert.deepEqual(insertReferenceAt('', 0, { path: 'README.md', kind: 'file' }), {
    text: '@README.md ',
    caret: 11,
  });
  assert.deepEqual(insertReferenceAt('lies ', 5, { path: 'docs/a.md', kind: 'file' }), {
    text: 'lies @docs/a.md ',
    caret: 16,
  });
  // Ordner wie in applyMention: abschließender „/“, kein Leerzeichen dahinter.
  assert.deepEqual(insertReferenceAt('', 0, { path: 'src', kind: 'directory' }), {
    text: '@src/',
    caret: 5,
  });
});

test('insertReferenceAt trennt vom Zeichen davor, damit das „@“ zählt', async () => {
  const { insertReferenceAt, findMentionQuery } = await modulePromise;

  const result = insertReferenceAt('lies', 4, { path: 'README.md', kind: 'file' });
  assert.deepEqual(result, { text: 'lies @README.md ', caret: 16 });
  // Ohne das eingefügte Leerzeichen wäre die Referenz für findMentionQuery keine.
  assert.deepEqual(findMentionQuery(result.text, result.caret - 1), { start: 5, query: 'README.md' });

  // Öffnende Klammer leitet ein „@“ selbst ein — kein zweites Zeichen davor.
  assert.deepEqual(insertReferenceAt('(', 1, { path: 'a.md', kind: 'file' }), {
    text: '(@a.md ',
    caret: 7,
  });
});

test('insertReferenceAt schreibt mitten im Text und übernimmt ein Leerzeichen', async () => {
  const { insertReferenceAt } = await modulePromise;

  // Cursor zwischen zwei Wörtern: der Rest bleibt stehen.
  assert.deepEqual(insertReferenceAt('lies  bitte', 5, { path: 'a.md', kind: 'file' }), {
    text: 'lies @a.md bitte',
    caret: 11,
  });
  // Cursor außerhalb des Texts wird begrenzt, fehlender Wert heißt Textende.
  assert.deepEqual(insertReferenceAt('x', 99, { path: 'a.md', kind: 'file' }), {
    text: 'x @a.md ',
    caret: 8,
  });
  assert.deepEqual(insertReferenceAt('', undefined, { path: 'a.md', kind: 'file' }), {
    text: '@a.md ',
    caret: 6,
  });
});
