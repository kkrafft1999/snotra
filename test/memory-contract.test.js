const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MEMORY_SCOPES,
  MEMORY_ORIGINS,
  parseMemoryEntries,
  formatMemoryEntryLine,
  appendMemoryEntry,
  removeMemoryEntryLine,
  normalizeMemoryFiles,
  formatMemoryDate,
} = require('../src/shared/contracts/memory');

test('eine Eintragszeile traegt Datum, Herkunft und Text', () => {
  assert.equal(
    formatMemoryEntryLine({ text: 'Tests laufen mit npm test', date: '2026-09-21' }),
    '- 2026-09-21 — Tests laufen mit npm test'
  );
  assert.equal(
    formatMemoryEntryLine({
      text: 'Releases gehen ueber einen PR',
      date: '2026-09-19',
      origin: MEMORY_ORIGINS.SELF,
    }),
    '- 2026-09-19 (selbst gemerkt) — Releases gehen ueber einen PR'
  );
});

test('mehrzeiliger Text wird zu einer Zeile — sonst zerfaellt der Eintrag in Muell', () => {
  const line = formatMemoryEntryLine({ text: 'erst so\n\n  dann so  ', date: '2026-09-21' });
  assert.equal(line, '- 2026-09-21 — erst so dann so');
  assert.equal(parseMemoryEntries(line).length, 1);
});

test('gelesen werden nur Listenzeilen, Prosa bleibt unangetastet', () => {
  const text = [
    '# Gedächtnis · Projekt',
    '',
    'Freitext, den jemand von Hand geschrieben hat.',
    '',
    '- 2026-09-21 — Tests laufen mit `npm test`.',
    '- 2026-09-19 (selbst gemerkt) — Releases gehen über einen PR.',
    '* ohne Datum geht auch',
  ].join('\n');
  const entries = parseMemoryEntries(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.text),
    ['Tests laufen mit `npm test`.', 'Releases gehen über einen PR.', 'ohne Datum geht auch']
  );
  assert.equal(entries[0].origin, MEMORY_ORIGINS.REQUESTED);
  assert.equal(entries[1].origin, MEMORY_ORIGINS.SELF);
  assert.equal(entries[2].date, null);
  // Die Zeilennummer ist der Schluessel zum Loeschen und muss auf die Datei
  // zeigen, nicht auf die Position in der Trefferliste.
  assert.deepEqual(entries.map((e) => e.line), [4, 5, 6]);
});

test('eine leere Datei bekommt beim ersten Eintrag ihre Ueberschrift', () => {
  const next = appendMemoryEntry('', {
    scope: MEMORY_SCOPES.USER,
    text: 'Anrede durchgängig Du',
    date: '2026-09-20',
  });
  assert.equal(next, '# Gedächtnis · global\n\n- 2026-09-20 — Anrede durchgängig Du\n');
});

test('neue Eintraege kommen ans Ende und lassen Bestehendes in Ruhe', () => {
  const before = '# Gedächtnis · Projekt\n\n- 2026-09-19 — Alt.\n';
  const after = appendMemoryEntry(before, { text: 'Neu.', date: '2026-09-21' });
  assert.equal(after, '# Gedächtnis · Projekt\n\n- 2026-09-19 — Alt.\n- 2026-09-21 — Neu.\n');
});

test('vergessen trifft genau eine Zeile', () => {
  const text = ['# Kopf', '', '- 2026-09-19 — Eins.', '- 2026-09-21 — Zwei.'].join('\n');
  const { text: next, removed } = removeMemoryEntryLine(text, 3);
  assert.equal(removed, true);
  assert.equal(next, '# Kopf\n\n- 2026-09-19 — Eins.');
});

test('eine Zeilennummer, die keine Eintragszeile trifft, aendert nichts', () => {
  const text = ['# Kopf', '', '- 2026-09-19 — Eins.'].join('\n');
  // Zeile 0 ist die Ueberschrift: Ein Vergessen, das die falsche Zeile trifft,
  // waere schlimmer als eines, das nichts tut.
  assert.deepEqual(removeMemoryEntryLine(text, 0), { text, removed: false });
  assert.deepEqual(removeMemoryEntryLine(text, 99), { text, removed: false });
  assert.deepEqual(removeMemoryEntryLine(text, -1), { text, removed: false });
});

test('leere und unbekannte Ebenen fallen aus der Dateiliste', () => {
  assert.deepEqual(
    normalizeMemoryFiles([
      { scope: MEMORY_SCOPES.WORKSPACE, text: 'da' },
      { scope: MEMORY_SCOPES.USER, text: '   ' },
      { scope: 'erfunden', text: 'da' },
      null,
    ]),
    [{ scope: MEMORY_SCOPES.WORKSPACE, text: 'da' }]
  );
  assert.deepEqual(normalizeMemoryFiles(null), []);
});

test('das Datum ist ortszeitlich und nullgepolstert', () => {
  assert.equal(formatMemoryDate(new Date(2026, 8, 5)), '2026-09-05');
  assert.match(formatMemoryDate(), /^\d{4}-\d{2}-\d{2}$/);
  // Ein unbrauchbares Datum faellt auf heute zurueck, statt "NaN-NaN-NaN" in
  // die Datei zu schreiben.
  assert.match(formatMemoryDate(new Date('kaputt')), /^\d{4}-\d{2}-\d{2}$/);
});
