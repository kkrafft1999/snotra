const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/utils/tool-log-debug.js');

test('Ring-Puffer behält nur die letzten Einträge und zählt fortlaufend', async () => {
  const { createToolLogDebug } = await load();
  let clock = 0;
  const debug = createToolLogDebug({ capacity: 3, now: () => (clock += 1), logger: { error() {} } });
  for (let i = 1; i <= 5; i += 1) debug.record('tool-line', { i });
  const entries = debug.snapshot();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.data.i), [3, 4, 5]);
  assert.deepEqual(entries.map((e) => e.seq), [3, 4, 5]);
  assert.equal(debug.size, 3);
});

test('recordIfChanged überspringt Wiederholungen desselben Zustands', async () => {
  const { createToolLogDebug } = await load();
  const debug = createToolLogDebug({ logger: { error() {} } });
  assert.ok(debug.recordIfChanged('summary', { text: 'a', count: 1 }));
  assert.equal(debug.recordIfChanged('summary', { text: 'a', count: 1 }), null);
  assert.ok(debug.recordIfChanged('summary', { text: 'b', count: 1 }));
  // Eine andere Art dazwischen ändert nichts am Vergleich je Art.
  debug.record('phase', { phase: 'waiting' });
  assert.equal(debug.recordIfChanged('summary', { text: 'b', count: 1 }), null);
  assert.equal(debug.size, 3);
});

test('guard fängt Fehler, hält sie fest und liefert sonst das Ergebnis', async () => {
  const { createToolLogDebug } = await load();
  const logged = [];
  const debug = createToolLogDebug({ logger: { error: (...args) => logged.push(args) } });
  assert.equal(debug.guard('ok', () => 42), 42);
  assert.equal(debug.errorCount, 0);
  const result = debug.guard('tool-line', () => { throw new TypeError('kaputt'); }, { phase: 'start' });
  assert.equal(result, undefined);
  assert.equal(debug.errorCount, 1);
  const entry = debug.snapshot().pop();
  assert.equal(entry.kind, 'error');
  assert.equal(entry.data.label, 'tool-line');
  assert.equal(entry.data.message, 'kaputt');
  assert.deepEqual(entry.data.context, { phase: 'start' });
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /tool-line/);
});

test('serialize liefert JSON mit Fehlerzähler und Einträgen; clear leert alles', async () => {
  const { createToolLogDebug } = await load();
  const debug = createToolLogDebug({ now: () => 1234, logger: { error() {} } });
  debug.record('phase', { phase: 'waiting' });
  const parsed = JSON.parse(debug.serialize());
  assert.equal(parsed.exportedAt, 1234);
  assert.equal(parsed.errorCount, 0);
  assert.equal(parsed.entries.length, 1);
  debug.clear();
  assert.equal(debug.size, 0);
  assert.equal(debug.errorCount, 0);
});

test('compactToolLinePayload lässt Argumente weg und kürzt lange Zeilen', async () => {
  const { compactToolLinePayload } = await load();
  const long = 'x'.repeat(300);
  const out = compactToolLinePayload({
    phase: 'pending', callIndex: 2, tool: 'read_file_text', line: long, args: { content: 'geheim' },
  });
  assert.deepEqual(Object.keys(out).sort(), ['callIndex', 'line', 'phase', 'tool']);
  assert.equal(out.line.length, 120);
  assert.ok(out.line.endsWith('…'));
  assert.deepEqual(compactToolLinePayload('Alt-Zeile'), { line: 'Alt-Zeile' });
  assert.deepEqual(compactToolLinePayload(null), { raw: 'null' });
});
