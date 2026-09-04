const test = require('node:test');
const assert = require('node:assert/strict');

// Renderer-Modul ist ESM ohne DOM-Bezug; Node 24 lädt es per Syntax-Erkennung.
const load = () => import('../src/renderer/utils/tool-log-summary.js');

test('toolLineText akzeptiert Strings (Alt-Sessions) und Objekte', async () => {
  const { toolLineText } = await load();
  assert.equal(toolLineText('Datei a.md gelesen'), 'Datei a.md gelesen');
  assert.equal(toolLineText({ line: 'aus line' }), 'aus line');
  assert.equal(toolLineText({ summary: 'aus summary' }), 'aus summary');
  assert.equal(toolLineText({ text: 'aus text' }), 'aus text');
  assert.equal(toolLineText(null), '');
  assert.equal(toolLineText(undefined), '');
});

test('formatMoreStepsLabel dekliniert korrekt', async () => {
  const { formatMoreStepsLabel } = await load();
  assert.equal(formatMoreStepsLabel(0), '');
  assert.equal(formatMoreStepsLabel(1), '1 weiterer Schritt');
  assert.equal(formatMoreStepsLabel(4), '4 weitere Schritte');
  assert.equal(formatMoreStepsLabel(-3), '');
  assert.equal(formatMoreStepsLabel('2'), '2 weitere Schritte');
});

test('leere Liste: nichts anzuzeigen, nicht aufklappbar', async () => {
  const { summarizeToolLog } = await load();
  assert.deepEqual(summarizeToolLog([]), {
    text: '',
    state: 'done',
    extra: '',
    count: 0,
    expandable: false,
  });
  assert.equal(summarizeToolLog(undefined).count, 0);
});

test('ein Schritt = eine Zeile ohne Aufklappen', async () => {
  const { summarizeToolLog } = await load();
  assert.deepEqual(summarizeToolLog([{ text: 'Datei README.md gelesen', state: 'done' }]), {
    text: 'Datei README.md gelesen',
    state: 'done',
    extra: '',
    count: 1,
    expandable: false,
  });
  const running = summarizeToolLog([{ text: 'Datei README.md wird gelesen …', state: 'running' }]);
  assert.equal(running.state, 'running');
  assert.equal(running.extra, '');
  assert.equal(running.expandable, false);
});

test('laufender Schritt gewinnt gegenüber erledigten, Zähler zeigt parallele Läufe', async () => {
  const { summarizeToolLog } = await load();
  const steps = [
    { text: 'Ordner src durchsucht', state: 'done' },
    { text: 'Datei a.js wird gelesen …', state: 'running' },
    { text: 'Datei b.js wird gelesen …', state: 'pending' },
    { text: 'Datei c.js wird gelesen …', state: 'pending' },
  ];
  assert.deepEqual(summarizeToolLog(steps), {
    text: 'Datei a.js wird gelesen …',
    state: 'running',
    extra: '+2',
    count: 4,
    expandable: true,
  });
});

test('nur vorläufige Schritte: Zustand pending, erster Eintrag zählt', async () => {
  const { summarizeToolLog } = await load();
  const out = summarizeToolLog([
    { text: 'Ordner src durchsucht', state: 'done' },
    { text: 'Datei a.js wird geschrieben …', state: 'pending' },
  ]);
  assert.equal(out.state, 'pending');
  assert.equal(out.text, 'Datei a.js wird geschrieben …');
  assert.equal(out.extra, '');
});

test('alles erledigt: letzter Schritt plus „N weitere Schritte“', async () => {
  const { summarizeToolLog } = await load();
  const five = ['a', 'b', 'c', 'd', 'Datei README.md gelesen'].map((text) => ({ text, state: 'done' }));
  assert.deepEqual(summarizeToolLog(five), {
    text: 'Datei README.md gelesen',
    state: 'done',
    extra: '· 4 weitere Schritte',
    count: 5,
    expandable: true,
  });
  const two = summarizeToolLog([
    { text: 'Ordner src durchsucht', state: 'done' },
    { text: 'Datei a.js gelesen', state: 'done' },
  ]);
  assert.equal(two.extra, '· 1 weiterer Schritt');
  assert.equal(two.expandable, true);
});

test('zwischen zwei Schritten (nichts läuft) steht der letzte erledigte Schritt', async () => {
  const { summarizeToolLog } = await load();
  const out = summarizeToolLog([
    { text: 'Ordner src durchsucht', state: 'done' },
    { text: 'Datei a.js gelesen', state: 'done' },
    { text: 'Datei b.js gelesen', state: 'done' },
  ]);
  assert.equal(out.text, 'Datei b.js gelesen');
  assert.equal(out.state, 'done');
  assert.equal(out.extra, '· 2 weitere Schritte');
});
