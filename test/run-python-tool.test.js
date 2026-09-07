// Tool run_python in der Registry (Issue #86). Der Runner ist gemockt — hier
// geht es um Sichtbarkeit, Vertrag und Ergebnisform, nicht um Python selbst.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { summarizeToolCall } = require('../src/shared/presentation/tool-display');
const { toolCategory, TOOL_CATEGORIES } = require('../src/shared/contracts/tool-categories');
const { createToolCallPlanner } = require('../src/main/tools/tool-call-planner');

function makeRegistry({ available = true, run } = {}) {
  const calls = [];
  const registry = createWorkspaceToolRegistry({
    fsService: {},
    pythonRunner: {
      isAvailable: () => available,
      async run(request) {
        calls.push(request);
        if (run) return run(request);
        return { stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false, aborted: false, truncated: false, durationMs: 7 };
      },
    },
  });
  return { registry, calls };
}

function exec(registry, args, context = {}) {
  return registry.execute('run_python', args, { approved: true, ...context });
}

test('run_python erscheint dem Modell nur, wenn es erlaubt und ein Interpreter da ist', () => {
  const aus = makeRegistry({ available: false }).registry;
  const an = makeRegistry({ available: true }).registry;

  assert.equal(aus.getTools().some((t) => t.function.name === 'run_python'), false);
  assert.equal(an.getTools().some((t) => t.function.name === 'run_python'), true);
  assert.equal(aus.buildSystemPrompt().includes('run_python'), false);
  assert.match(an.buildSystemPrompt(), /run_python/);
});

test('run_python trägt die höchste Risikoklasse und ist damit nie dauerhaft freigebbar', () => {
  const { registry } = makeRegistry();
  const {
    SESSION_GRANTABLE_CLASSES,
    PERSISTENT_ALLOW_CLASSES,
  } = require('../src/shared/contracts/tool-permissions');

  assert.equal(registry.getDefinition('run_python').riskClass, 'execute');
  // Konzept §6/§7: „execute" steht in keiner der beiden Listen — es wird vor
  // jedem Lauf erneut gefragt, ein „für diese Sitzung merken" gibt es nicht.
  assert.equal(SESSION_GRANTABLE_CLASSES.includes('execute'), false);
  assert.equal(PERSISTENT_ALLOW_CLASSES.includes('execute'), false);
});

test('run_python läuft nicht, wenn es abgeschaltet oder nicht eingerichtet ist', async () => {
  const gesperrt = makeRegistry({ available: false });
  assert.match(JSON.parse(await exec(gesperrt.registry, { code: 'print(1)' })).error, /nicht eingerichtet/);
  assert.equal(gesperrt.calls.length, 0);

  const abgewaehlt = makeRegistry();
  const out = JSON.parse(await exec(abgewaehlt.registry, { code: 'print(1)' }, { disabledNames: ['run_python'] }));
  assert.match(out.error, /deaktiviert/);
  assert.equal(abgewaehlt.calls.length, 0);
});

test('run_python läuft ohne Freigabe der Policy nicht', async () => {
  const { registry, calls } = makeRegistry();
  await registry.execute('run_python', { code: 'print(1)' }, {});
  assert.equal(calls.length, 0);
});

test('run_python reicht Code, stdin, argv, Zeitlimit und Arbeitsordner durch', async () => {
  const { registry, calls } = makeRegistry();
  const signal = new AbortController().signal;

  await exec(
    registry,
    { code: 'print(1)', stdin: 'x', argv: ['a'], timeout_ms: 2500 },
    { workspaceRoot: '/tmp/projekt', abortSignal: signal },
  );

  assert.deepEqual(calls[0], {
    code: 'print(1)',
    stdin: 'x',
    argv: ['a'],
    timeoutMs: 2500,
    cwd: '/tmp/projekt',
    abortSignal: signal,
  });
});

test('run_python liefert ein strukturiertes Ergebnis', async () => {
  const { registry } = makeRegistry({
    run: () => ({ stdout: '5050\n', stderr: 'warnung\n', exitCode: 0, timedOut: false, aborted: false, truncated: false, durationMs: 12 }),
  });

  const out = JSON.parse(await exec(registry, { code: 'print(1)' }));
  assert.deepEqual(out, { stdout: '5050\n', stderr: 'warnung\n', exit_code: 0, duration_ms: 12 });
});

test('run_python meldet Zeitüberschreitung, Abbruch und Kappung als Felder', async () => {
  const zeit = makeRegistry({
    run: () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true, aborted: false, truncated: false, durationMs: 10000 }),
  });
  const outZeit = JSON.parse(await exec(zeit.registry, { code: 'while True: pass' }));
  assert.equal(outZeit.timed_out, true);
  assert.match(outZeit.note, /Zeitlimit/);

  const stop = makeRegistry({
    run: () => ({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true, truncated: false, durationMs: 400 }),
  });
  const outStop = JSON.parse(await exec(stop.registry, { code: 'x' }));
  assert.equal(outStop.aborted, true);

  const viel = makeRegistry({
    run: () => ({ stdout: 'x', stderr: '', exitCode: 0, timedOut: false, aborted: false, truncated: true, durationMs: 30 }),
  });
  assert.equal(JSON.parse(await exec(viel.registry, { code: 'x' })).truncated, true);
});

test('run_python gibt einen Fehler des Runners als Tool-Ergebnis zurück', async () => {
  const { registry } = makeRegistry({ run: () => ({ error: 'Kein Python-Interpreter gefunden.' }) });
  assert.equal(JSON.parse(await exec(registry, { code: 'x' })).error, 'Kein Python-Interpreter gefunden.');
});

test('die Freigabe-Karte bekommt den vollständigen Quelltext als Vorschau', async () => {
  const { registry } = makeRegistry();
  const planner = createToolCallPlanner({
    fsService: {},
    fs: require('fs').promises,
    path: require('path'),
  });

  const plan = await planner.plan(registry.getDefinition('run_python'), { code: 'print("hallo")' }, {
    workspaceRoot: '/tmp/projekt',
  });

  assert.equal(plan.preview.kind, 'code');
  assert.equal(plan.preview.text, 'print("hallo")');
  assert.deepEqual(plan.riskClasses, ['execute']);
});

test('run_python hat eine eigene Kategorie und eine deutsche Anzeige-Zeile', () => {
  assert.equal(toolCategory('run_python'), TOOL_CATEGORIES.EXEC);
  assert.equal(summarizeToolCall('run_python', { code: 'print(1)' }, 'start'), 'Python wird ausgeführt (1 Zeile) …');
  assert.equal(
    summarizeToolCall('run_python', { code: 'a = 1\n\nprint(a)' }, 'done'),
    'Python ausgeführt (2 Zeilen)',
  );
  assert.equal(summarizeToolCall('run_python', {}, 'done'), 'Python ausgeführt');
});
