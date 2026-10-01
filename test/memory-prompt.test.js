const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUserMemorySystemPrompt,
  buildFolderMemorySystemPrompt,
  TRUNCATION_NOTE,
} = require('../src/application/chat/memory-prompt');

// Both levels, each from its own builder (#529) — for the tests that look at
// what the two have in common.
function buildMemorySystemPrompt(files) {
  const user = buildUserMemorySystemPrompt(files);
  const folder = buildFolderMemorySystemPrompt(files);
  return {
    text: [folder.text, user.text].filter(Boolean).join('\n\n'),
    parts: [...folder.parts, ...user.parts],
  };
}
const { MEMORY_SCOPES, MAX_MEMORY_CHARS } = require('../src/shared/contracts/memory');

test('ohne Gedaechtnis entsteht kein Block', () => {
  assert.deepEqual(buildMemorySystemPrompt([]), { text: '', parts: [] });
  assert.deepEqual(buildMemorySystemPrompt(null), { text: '', parts: [] });
  assert.deepEqual(buildMemorySystemPrompt([{ scope: MEMORY_SCOPES.USER, text: '  ' }]), {
    text: '',
    parts: [],
  });
});

test('beide Ebenen stehen unter eigener Ueberschrift im Block', () => {
  const { text } = buildMemorySystemPrompt([
    { scope: MEMORY_SCOPES.WORKSPACE, text: '- 2026-09-21 — Tests mit npm test.' },
    { scope: MEMORY_SCOPES.USER, text: '- 2026-09-20 — Anrede Du.' },
  ]);
  assert.match(text, /## Memory \(project\)/);
  assert.match(text, /## Memory \(global\)/);
  assert.match(text, /Tests mit npm test/);
  assert.match(text, /Anrede Du/);
  // Der Block muss sagen, dass Eintraege altern koennen — sonst haelt das
  // Modell eine alte Notiz gegen das, was der Nutzer gerade sagt.
  assert.match(text, /now wins/);
});

test('eine gekuerzte Datei sagt das im Prompt', () => {
  const { text } = buildMemorySystemPrompt([
    { scope: MEMORY_SCOPES.USER, text: 'x'.repeat(MAX_MEMORY_CHARS), truncated: true },
  ]);
  assert.ok(text.endsWith(TRUNCATION_NOTE));
});

test('je Ebene eine eigene Zeile in der Token-Aufschluesselung', () => {
  const { parts } = buildMemorySystemPrompt([
    { scope: MEMORY_SCOPES.WORKSPACE, text: 'abc' },
    { scope: MEMORY_SCOPES.USER, text: 'defgh' },
  ]);
  assert.deepEqual(
    parts.map((p) => p.id),
    ['system:memory:workspace', 'system:memory:user']
  );
  // Die Aufschluesselung steht auf dem Bildschirm und traegt deshalb den
  // Katalogschluessel, nicht den fertigen Satz (#293) — anders als die
  // gleichnamige Ueberschrift im Prompt, die englisch bleibt (#276).
  assert.deepEqual(
    parts.map((p) => p.labelKey),
    ['memory.scope.workspace', 'memory.scope.user']
  );
  // Gezaehlt wird der Dateitext, nicht Ueberschrift und Vorspann — sonst
  // waere nicht zu erkennen, welche Datei den Prompt aufblaeht.
  assert.deepEqual(parts.map((p) => p.chars), [3, 5]);
  // The path as a key and its value: `<folder>/` is a word and is worded on
  // screen (#353).
  assert.deepEqual(parts.map((p) => [p.detailKey, p.params]), [
    ['context.detail.folderPath', { path: '.agents/memory.md' }],
    ['context.detail.path', { path: '~/.snotra/memory.md' }],
  ]);
});

test('die Zeile einer gekuerzten Datei sagt es auch in der Aufschluesselung', () => {
  const { parts } = buildMemorySystemPrompt([
    { scope: MEMORY_SCOPES.USER, text: 'abc', truncated: true },
  ]);
  assert.equal(parts[0].detailKey, 'context.detail.pathTruncated');
});

test('the folder placeholder follows the interface language (#353)', () => {
  const { translate } = require('../src/shared/i18n');
  const { parts } = buildMemorySystemPrompt([{ scope: MEMORY_SCOPES.WORKSPACE, text: 'a', truncated: true }]);
  assert.equal(translate('en', parts[0].detailKey, parts[0].params), '<folder>/.agents/memory.md · shortened');
  assert.equal(translate('de', parts[0].detailKey, parts[0].params), '<Ordner>/.agents/memory.md · gekürzt');
});

test('each builder takes only its own level (#529)', () => {
  const files = [
    { scope: MEMORY_SCOPES.WORKSPACE, text: 'folder note' },
    { scope: MEMORY_SCOPES.USER, text: 'user note' },
  ];
  const user = buildUserMemorySystemPrompt(files);
  const folder = buildFolderMemorySystemPrompt(files);
  assert.match(user.text, /user note/);
  assert.doesNotMatch(user.text, /folder note/);
  assert.match(folder.text, /folder note/);
  assert.doesNotMatch(folder.text, /user note/);
  assert.deepEqual(user.parts.map((p) => p.id), ['system:memory:user']);
  assert.deepEqual(folder.parts.map((p) => p.id), ['system:memory:workspace']);
});

test('the folder memory is introduced by where it comes from, not as the user\'s words (#529)', () => {
  const user = buildUserMemorySystemPrompt([{ scope: MEMORY_SCOPES.USER, text: 'a' }]);
  const folder = buildFolderMemorySystemPrompt([{ scope: MEMORY_SCOPES.WORKSPACE, text: 'a' }]);
  assert.match(user.text, /^Your memory\. The user gave you this/);
  assert.doesNotMatch(folder.text, /The user gave you this|Your memory/);
  assert.match(folder.text, /^Notes kept in this folder \(\.agents\/memory\.md\)/);
  assert.match(folder.text, /not the user's own words/);
  // Both say that an entry can be out of date.
  assert.match(user.text, /now wins/);
  assert.match(folder.text, /now wins/);
});
