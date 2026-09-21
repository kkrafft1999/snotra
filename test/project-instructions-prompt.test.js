const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProjectInstructionsSystemPrompt,
  TRUNCATION_NOTE,
} = require('../src/application/chat/project-instructions-prompt');
const {
  PROJECT_INSTRUCTION_SOURCES: SRC,
  PROJECT_INSTRUCTION_SOURCE_ORDER,
  MAX_PROJECT_INSTRUCTION_CHARS,
} = require('../src/shared/contracts/project-instructions');

/** Die Überschriften in der Reihenfolge, in der sie im Block stehen. */
function headings(text) {
  return [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
}

test('alle vier Stufen stehen von allgemein nach speziell im Block (#212)', () => {
  const { text } = buildProjectInstructionsSystemPrompt([
    { source: SRC.WORKSPACE_AGENTS, text: 'vier' },
    { source: SRC.USER_SNOTRA, text: 'zwei' },
    { source: SRC.WORKSPACE_ROOT, text: 'drei' },
    { source: SRC.USER_AGENTS, text: 'eins' },
  ]);
  assert.deepEqual(headings(text), [
    'AGENTS.md (global)',
    'AGENTS.md (global, .snotra)',
    'AGENTS.md (Projekt)',
    'AGENTS.md (Projekt, .agents)',
  ]);
  // Die Eingabereihenfolge ist egal — maßgeblich ist die Kette.
  assert.ok(text.indexOf('eins') < text.indexOf('zwei'));
  assert.ok(text.indexOf('zwei') < text.indexOf('drei'));
  assert.ok(text.indexOf('drei') < text.indexOf('vier'));
  assert.match(text, /gilt die weiter unten stehende/);
});

test('jede Teilmenge der Kette funktioniert, auch eine einzelne Datei', () => {
  for (const source of PROJECT_INSTRUCTION_SOURCE_ORDER) {
    const { text, parts } = buildProjectInstructionsSystemPrompt([{ source, text: 'Regel.' }]);
    assert.equal(headings(text).length, 1);
    assert.equal(parts.length, 1);
    // Der Hinweis auf die Rangfolge gehört zu „mehrere", nicht zu „eine".
    assert.ok(!text.includes('gilt die weiter unten stehende'));
  }
  const zwei = buildProjectInstructionsSystemPrompt([
    { source: SRC.USER_SNOTRA, text: 'a' },
    { source: SRC.WORKSPACE_AGENTS, text: 'b' },
  ]);
  assert.deepEqual(headings(zwei.text), ['AGENTS.md (global, .snotra)', 'AGENTS.md (Projekt, .agents)']);
});

test('ohne Dateien gibt es keinen Block und keine leere Überschrift', () => {
  for (const input of [undefined, null, [], 'kaputt', [null, {}, { source: 'erfunden', text: 'x' }]]) {
    const { text, parts } = buildProjectInstructionsSystemPrompt(input);
    assert.equal(text, '');
    assert.deepEqual(parts, []);
  }
});

test('eine leere oder nur aus Leerzeichen bestehende Datei fällt weg', () => {
  const { text, parts } = buildProjectInstructionsSystemPrompt([
    { source: SRC.USER_AGENTS, text: '   \n\t ' },
    { source: SRC.WORKSPACE_ROOT, text: '  Nutze npm.  ' },
  ]);
  assert.deepEqual(headings(text), ['AGENTS.md (Projekt)']);
  assert.equal(parts.length, 1);
  // Der Inhalt wird beschnitten, damit keine Leerzeile unter der Überschrift steht.
  assert.match(text, /## AGENTS\.md \(Projekt\)\n\nNutze npm\.$/);
});

test('gekürzte Dateien sind im Prompt und in der Aufschlüsselung als solche erkennbar', () => {
  const { text, parts } = buildProjectInstructionsSystemPrompt([
    { source: SRC.WORKSPACE_ROOT, text: 'x'.repeat(50), truncated: true },
  ]);
  assert.ok(text.endsWith(TRUNCATION_NOTE));
  assert.match(TRUNCATION_NOTE, new RegExp(String(MAX_PROJECT_INSTRUCTION_CHARS)));
  assert.match(parts[0].detail, /gekürzt$/);
  // Gezählt wird der Text, der wirklich mitgeht.
  assert.equal(parts[0].chars, 50);
});

test('je Datei eine eigene Zeile in der Kontext-Aufschlüsselung (#174)', () => {
  const { parts } = buildProjectInstructionsSystemPrompt([
    { source: SRC.USER_AGENTS, text: 'eins' },
    { source: SRC.WORKSPACE_AGENTS, text: 'zwei' },
  ]);
  assert.deepEqual(parts.map((p) => p.id), [
    'system:agents-md:user-agents',
    'system:agents-md:workspace-agents',
  ]);
  assert.deepEqual(parts.map((p) => p.group), ['system', 'system']);
  assert.deepEqual(parts.map((p) => p.detail), ['~/.agents/AGENTS.md', '<Ordner>/.agents/AGENTS.md']);
  // Der Kurzpfad nennt bewusst weder das aufgelöste Home noch den Ordnernamen.
  for (const part of parts) assert.ok(!part.detail.includes('/Users/'));
});

test('dieselbe Quelle zweimal zählt einmal', () => {
  const { text, parts } = buildProjectInstructionsSystemPrompt([
    { source: SRC.USER_AGENTS, text: 'erste' },
    { source: SRC.USER_AGENTS, text: 'zweite' },
  ]);
  assert.equal(parts.length, 1);
  assert.match(text, /erste/);
  assert.ok(!text.includes('zweite'));
});
