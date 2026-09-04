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
    category: null,
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
    category: null,
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
    category: null,
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
    category: null,
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

test('formatStepCountLabel dekliniert korrekt', async () => {
  const { formatStepCountLabel } = await load();
  assert.equal(formatStepCountLabel(0), '');
  assert.equal(formatStepCountLabel(1), '1 Schritt');
  assert.equal(formatStepCountLabel(5), '5 Schritte');
});

test('Nachdenken zwischen Runden: Zeile zeigt „Modell denkt nach …“ mit Schrittzähler', async () => {
  const { summarizeToolLog, THINKING_LABEL } = await load();
  const done = ['a', 'b', 'c'].map((text) => ({ text, state: 'done' }));
  assert.deepEqual(summarizeToolLog(done, { thinking: true }), {
    text: THINKING_LABEL,
    state: 'running',
    extra: '· 3 Schritte',
    category: null,
    count: 3,
    expandable: true,
  });
  // Ein einzelner Schritt ist beim Nachdenken trotzdem aufklappbar — die Zeile zeigt ihn ja nicht.
  const one = summarizeToolLog([{ text: 'Datei a.js gelesen', state: 'done' }], { thinking: true });
  assert.equal(one.extra, '· 1 Schritt');
  assert.equal(one.expandable, true);
});

test('Nachdenken: laufender Schritt hat Vorrang, ohne Schritte bleibt die Zeile leer', async () => {
  const { summarizeToolLog } = await load();
  const withActive = summarizeToolLog(
    [
      { text: 'Datei a.js gelesen', state: 'done' },
      { text: 'Datei b.js wird gelesen …', state: 'running' },
    ],
    { thinking: true }
  );
  assert.equal(withActive.text, 'Datei b.js wird gelesen …');
  assert.equal(withActive.extra, '');
  const empty = summarizeToolLog([], { thinking: true });
  assert.equal(empty.count, 0);
  assert.equal(empty.text, '');
  assert.equal(empty.expandable, false);
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

test('formatGroupLabel dekliniert je Kategorie', async () => {
  const { formatGroupLabel } = await load();
  assert.equal(formatGroupLabel('read', 1), '1 Datei gelesen');
  assert.equal(formatGroupLabel('read', 4), '4 Dateien gelesen');
  assert.equal(formatGroupLabel('search', 1), '1 Suche');
  assert.equal(formatGroupLabel('search', 2), '2 Suchen');
  assert.equal(formatGroupLabel('check', 3), '3 Pfade geprüft');
  assert.equal(formatGroupLabel('write', 1), '1 Datei geschrieben');
  assert.equal(formatGroupLabel('unbekannt', 2), '2 Tool-Schritte');
  assert.equal(formatGroupLabel('read', 0), '');
});

test('groupToolSteps zählt in der Reihenfolge des ersten Auftretens', async () => {
  const { groupToolSteps } = await load();
  const steps = [
    { text: 'a', state: 'done', category: 'search' },
    { text: 'b', state: 'done', category: 'read' },
    { text: 'c', state: 'done', category: 'read' },
    { text: 'd', state: 'done', category: 'search' },
  ];
  assert.deepEqual(groupToolSteps(steps), [
    { category: 'search', count: 2 },
    { category: 'read', count: 2 },
  ]);
  // Ohne Kategorie landet alles im Sammelbecken.
  assert.deepEqual(groupToolSteps([{ text: 'x', state: 'done' }]), [{ category: 'other', count: 1 }]);
});

test('abgeschlossen mit Kategorien: gruppierte Zeile, wichtigste Gruppe zuerst', async () => {
  const { summarizeToolLog } = await load();
  const steps = [
    { text: 'Ordner src durchsucht', state: 'done', category: 'list' },
    { text: 'Datei a.js gelesen', state: 'done', category: 'read' },
    { text: 'Datei b.js gelesen', state: 'done', category: 'read' },
    { text: 'Nach „foo“ gesucht', state: 'done', category: 'search' },
  ];
  // Rang statt Reihenfolge: Suche vor Lesen vor Auflisten.
  assert.deepEqual(summarizeToolLog(steps), {
    text: '1 Suche · 2 Dateien gelesen · 1 Ordner aufgelistet',
    state: 'done',
    extra: '',
    category: 'search',
    count: 4,
    expandable: true,
  });
});

test('mehr als drei Gruppen: Rest wird als „N weitere Schritte“ gezählt', async () => {
  const { summarizeToolLog } = await load();
  const steps = [
    { text: 'a', state: 'done', category: 'read' },
    { text: 'b', state: 'done', category: 'search' },
    { text: 'c', state: 'done', category: 'list' },
    { text: 'd', state: 'done', category: 'write' },
    { text: 'e', state: 'done', category: 'wait' },
  ];
  // Auflistung und Pause sind die unwichtigsten und fallen in den Rest.
  const out = summarizeToolLog(steps);
  assert.equal(out.text, '1 Datei geschrieben · 1 Suche · 1 Datei gelesen');
  assert.equal(out.extra, '· 2 weitere Schritte');
  assert.equal(out.category, 'write');
});

test('Alt-Sessions ohne Kategorie behalten „letzter Schritt · N weitere“', async () => {
  const { summarizeToolLog } = await load();
  const steps = [
    { text: 'Ordner src durchsucht', state: 'done' },
    { text: 'Datei README.md gelesen', state: 'done', category: 'other' },
  ];
  const out = summarizeToolLog(steps);
  assert.equal(out.text, 'Datei README.md gelesen');
  assert.equal(out.extra, '· 1 weiterer Schritt');
  assert.equal(out.category, null);
});

test('laufender Schritt liefert seine Kategorie fürs Symbol', async () => {
  const { summarizeToolLog } = await load();
  const out = summarizeToolLog([
    { text: 'Datei a.js gelesen', state: 'done', category: 'read' },
    { text: 'Datei b.md wird geschrieben …', state: 'running', category: 'write' },
  ]);
  assert.equal(out.category, 'write');
  assert.equal(out.state, 'running');
  // Beim Nachdenken zeigt die Zeile kein Symbol.
  assert.equal(summarizeToolLog([{ text: 'a', state: 'done', category: 'read' }], { thinking: true }).category, null);
});

test('Skill-Zugriffe stehen in der Zusammenfassung vorn', async () => {
  const { summarizeToolLog, formatGroupLabel } = await load();
  assert.equal(formatGroupLabel('skill', 1), '1 Skill-Zugriff');
  assert.equal(formatGroupLabel('skill', 3), '3 Skill-Zugriffe');

  const steps = [
    { text: 'Ordner src durchsucht', state: 'done', category: 'list' },
    { text: 'Datei (Skill foo) gelesen', state: 'done', category: 'skill' },
    { text: 'Datei a.js gelesen', state: 'done', category: 'read' },
    { text: 'Datei b.js gelesen', state: 'done', category: 'read' },
  ];
  const out = summarizeToolLog(steps);
  // Skill-Zugriff ist Rang 1, obwohl er erst als zweiter Schritt lief.
  assert.equal(out.text, '1 Skill-Zugriff · 2 Dateien gelesen · 1 Ordner aufgelistet');
  assert.equal(out.extra, '');
  assert.equal(out.category, 'skill');
});
