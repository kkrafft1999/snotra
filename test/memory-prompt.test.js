const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMemorySystemPrompt, TRUNCATION_NOTE } = require('../src/application/chat/memory-prompt');
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
  assert.match(text, /## Gedächtnis \(Projekt\)/);
  assert.match(text, /## Gedächtnis \(global\)/);
  assert.match(text, /Tests mit npm test/);
  assert.match(text, /Anrede Du/);
  // Der Block muss sagen, dass Eintraege altern koennen — sonst haelt das
  // Modell eine alte Notiz gegen das, was der Nutzer gerade sagt.
  assert.match(text, /gilt das Jetzt/);
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
  assert.deepEqual(
    parts.map((p) => p.label),
    ['Gedächtnis (Projekt)', 'Gedächtnis (global)']
  );
  // Gezaehlt wird der Dateitext, nicht Ueberschrift und Vorspann — sonst
  // waere nicht zu erkennen, welche Datei den Prompt aufblaeht.
  assert.deepEqual(parts.map((p) => p.chars), [3, 5]);
  assert.deepEqual(parts.map((p) => p.detail), [
    '<Ordner>/.agents/memory.md',
    '~/.snotra/memory.md',
  ]);
});

test('die Zeile einer gekuerzten Datei sagt es auch in der Aufschluesselung', () => {
  const { parts } = buildMemorySystemPrompt([
    { scope: MEMORY_SCOPES.USER, text: 'abc', truncated: true },
  ]);
  assert.match(parts[0].detail, /gekürzt/);
});
