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

test('alle drei Quellen stehen in der Reihenfolge aus #251 im Block', () => {
  const { text } = buildProjectInstructionsSystemPrompt([
    { source: SRC.USER_AGENTS, text: 'drei' },
    { source: SRC.WORKSPACE_AGENTS, text: 'eins' },
    { source: SRC.USER_SNOTRA, text: 'zwei' },
  ]);
  assert.deepEqual(headings(text), [
    'AGENTS.md (Projekt)',
    'AGENTS.md (global)',
    'AGENTS.md (global, Alt-Ort)',
  ]);
  // Die Eingabereihenfolge ist egal — maßgeblich ist die Quellenliste.
  assert.ok(text.indexOf('eins') < text.indexOf('zwei'));
  assert.ok(text.indexOf('zwei') < text.indexOf('drei'));
});

test('der Block sagt, dass die Dateien einander ergänzen — und behauptet keine Rangfolge (#253)', () => {
  const { text } = buildProjectInstructionsSystemPrompt([
    { source: SRC.WORKSPACE_AGENTS, text: 'eins' },
    { source: SRC.USER_AGENTS, text: 'zwei' },
  ]);
  assert.match(text, /ergänzen einander/);
  assert.match(text, /Alle gelten gemeinsam, keine ersetzt eine andere/);
  // Der Vorrang-Satz aus #212 darf nicht zurückkommen: Er hat das Modell
  // aufgefordert, sich eine der Dateien auszusuchen.
  assert.ok(!/gilt die weiter unten stehende|gewinnt|Vorrang/i.test(text), text);
});

test('die Ordnerwurzel ist keine Quelle mehr (#253)', () => {
  assert.ok(!PROJECT_INSTRUCTION_SOURCE_ORDER.includes('workspace-root'));
  const { text, parts } = buildProjectInstructionsSystemPrompt([
    { source: 'workspace-root', text: 'aus der Ordnerwurzel' },
  ]);
  assert.equal(text, '');
  assert.deepEqual(parts, []);
});

test('jede Teilmenge funktioniert, auch eine einzelne Datei', () => {
  for (const source of PROJECT_INSTRUCTION_SOURCE_ORDER) {
    const { text, parts } = buildProjectInstructionsSystemPrompt([{ source, text: 'Regel.' }]);
    assert.equal(headings(text).length, 1);
    assert.equal(parts.length, 1);
    // Der Hinweis aufs Ergänzen gehört zu „mehrere", nicht zu „eine".
    assert.ok(!text.includes('ergänzen einander'));
  }
  const zwei = buildProjectInstructionsSystemPrompt([
    { source: SRC.USER_AGENTS, text: 'a' },
    { source: SRC.WORKSPACE_AGENTS, text: 'b' },
  ]);
  assert.deepEqual(headings(zwei.text), ['AGENTS.md (Projekt)', 'AGENTS.md (global, Alt-Ort)']);
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
    { source: SRC.WORKSPACE_AGENTS, text: '  Nutze npm.  ' },
  ]);
  assert.deepEqual(headings(text), ['AGENTS.md (Projekt)']);
  assert.equal(parts.length, 1);
  // Der Inhalt wird beschnitten, damit keine Leerzeile unter der Überschrift steht.
  assert.match(text, /## AGENTS\.md \(Projekt\)\n\nNutze npm\.$/);
});

test('gekürzte Dateien sind im Prompt und in der Aufschlüsselung als solche erkennbar', () => {
  const { text, parts } = buildProjectInstructionsSystemPrompt([
    { source: SRC.WORKSPACE_AGENTS, text: 'x'.repeat(50), truncated: true },
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
    'system:agents-md:workspace-agents',
    'system:agents-md:user-agents',
  ]);
  assert.deepEqual(parts.map((p) => p.group), ['system', 'system']);
  assert.deepEqual(parts.map((p) => p.detail), ['<Ordner>/.agents/AGENTS.md', '~/.agents/AGENTS.md']);
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
