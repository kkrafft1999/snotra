// Tool shell_execute in Registry, Planer und Anzeige (Issue #102). Der Runner
// ist gemockt — hier geht es um Sichtbarkeit, Vertrag, Sperren und die
// Freigabekarte, nicht um die Shell selbst (die prueft
// shell-runner-service.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');
const { pathToFileURL } = require('url');

const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createToolCallPlanner } = require('../src/main/tools/tool-call-planner');
const { summarizeToolCall } = require('../src/shared/presentation/tool-display');
const { toolCategory, TOOL_CATEGORIES } = require('../src/shared/contracts/tool-categories');

const loadApprovalView = () =>
  import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'utils', 'tool-approval-view.js')).href);

const WORKSPACE = nodePath.resolve('/tmp/projekt');

/** Loest relative Pfade im Projektordner auf und lehnt alles darueber ab. */
function makeFsServiceStub() {
  return {
    async resolveToolPath(workspaceRoot, relativePath) {
      if (!workspaceRoot) return { error: 'Kein Arbeitsordner geöffnet.' };
      const rel = typeof relativePath === 'string' ? relativePath : '';
      const absPath = nodePath.resolve(workspaceRoot, rel);
      const inside = nodePath.relative(workspaceRoot, absPath);
      if (inside.startsWith('..') || nodePath.isAbsolute(inside)) {
        return { error: 'Pfad liegt außerhalb des Projektordners.' };
      }
      return { absPath, root: workspaceRoot, prefix: '', skillName: null };
    },
  };
}

function makeRegistry({ available = true, run } = {}) {
  const calls = [];
  const registry = createWorkspaceToolRegistry({
    fsService: makeFsServiceStub(),
    shellRunner: {
      isAvailable: () => available,
      async run(request) {
        calls.push(request);
        if (run) return run(request);
        return {
          stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false,
          aborted: false, truncated: false, durationMs: 7, shell: 'zsh',
        };
      },
    },
  });
  return { registry, calls };
}

function exec(registry, args, context = {}) {
  return registry.execute('shell_execute', args, { approved: true, workspaceRoot: WORKSPACE, ...context });
}

function makePlanner(describeShell) {
  return createToolCallPlanner({
    fsService: makeFsServiceStub(),
    fs: require('fs').promises,
    path: nodePath,
    describeShell,
  });
}

test('shell_execute erscheint dem Modell nur, wenn es erlaubt und eine Shell da ist', () => {
  const aus = makeRegistry({ available: false }).registry;
  const an = makeRegistry({ available: true }).registry;

  assert.equal(aus.getTools().some((t) => t.function.name === 'shell_execute'), false);
  assert.equal(an.getTools().some((t) => t.function.name === 'shell_execute'), true);
  assert.equal(aus.buildSystemPrompt().includes('shell_execute'), false);
  assert.match(an.buildSystemPrompt(), /shell_execute/);
});

test('shell_execute trägt die höchste Risikoklasse und ist damit nie dauerhaft freigebbar', () => {
  const { registry } = makeRegistry();
  const {
    SESSION_GRANTABLE_CLASSES,
    PERSISTENT_ALLOW_CLASSES,
  } = require('../src/shared/contracts/tool-permissions');

  assert.equal(registry.getDefinition('shell_execute').riskClass, 'execute');
  // Konzept §6/§7: „execute" steht in keiner der beiden Listen — es wird vor
  // jedem Lauf erneut gefragt, ein „für diese Sitzung merken" gibt es nicht.
  assert.equal(SESSION_GRANTABLE_CLASSES.includes('execute'), false);
  assert.equal(PERSISTENT_ALLOW_CLASSES.includes('execute'), false);
  // Ohne geoeffneten Projektordner gibt es kein Arbeitsverzeichnis (#96).
  assert.equal(registry.getDefinition('shell_execute').requiresWorkspace, true);
});

test('shell_execute läuft nicht, wenn es abgeschaltet oder nicht eingerichtet ist', async () => {
  const gesperrt = makeRegistry({ available: false });
  assert.match(JSON.parse(await exec(gesperrt.registry, { command: 'ls' })).error, /nicht eingerichtet/);
  assert.equal(gesperrt.calls.length, 0);

  const abgewaehlt = makeRegistry();
  const out = JSON.parse(await exec(abgewaehlt.registry, { command: 'ls' }, { disabledNames: ['shell_execute'] }));
  assert.match(out.error, /deaktiviert/);
  assert.equal(abgewaehlt.calls.length, 0);
});

test('shell_execute läuft ohne Freigabe der Policy nicht', async () => {
  const { registry, calls } = makeRegistry();
  await registry.execute('shell_execute', { command: 'ls' }, { workspaceRoot: WORKSPACE });
  assert.equal(calls.length, 0);
});

test('shell_execute reicht Befehl, stdin, Zeitlimit und Arbeitsordner durch', async () => {
  const { registry, calls } = makeRegistry();
  const signal = new AbortController().signal;

  await exec(
    registry,
    { command: 'git status', cwd: 'frontend', stdin: 'x', timeout_ms: 2500 },
    { abortSignal: signal },
  );

  assert.deepEqual(calls[0], {
    command: 'git status',
    stdin: 'x',
    timeoutMs: 2500,
    cwd: nodePath.join(WORKSPACE, 'frontend'),
    abortSignal: signal,
  });

  // Ohne cwd laeuft der Befehl im Projektordner.
  await exec(registry, { command: 'git status' });
  assert.equal(calls[1].cwd, WORKSPACE);
});

test('ein Arbeitsordner außerhalb des Projektordners erreicht die Shell nicht', async () => {
  const { registry, calls } = makeRegistry();
  const out = JSON.parse(await exec(registry, { command: 'ls', cwd: '../..' }));
  assert.match(out.error, /außerhalb/);
  assert.equal(calls.length, 0);
});

test('shell_execute liefert ein strukturiertes Ergebnis samt Shell und Arbeitsordner', async () => {
  const { registry } = makeRegistry({
    run: () => ({
      stdout: ' M README.md\n', stderr: 'hinweis\n', exitCode: 0, timedOut: false,
      aborted: false, truncated: false, durationMs: 12, shell: 'zsh',
    }),
  });

  const out = JSON.parse(await exec(registry, { command: 'git status --short', cwd: 'docs' }));
  assert.deepEqual(out, {
    stdout: ' M README.md\n',
    stderr: 'hinweis\n',
    exit_code: 0,
    duration_ms: 12,
    shell: 'zsh',
    cwd: 'docs',
  });
});

test('ein fehlschlagender Befehl ist ein normales Ergebnis mit Exit-Code', async () => {
  const { registry } = makeRegistry({
    run: () => ({
      stdout: '', stderr: 'command not found: gibtsnicht\n', exitCode: 127,
      timedOut: false, aborted: false, truncated: false, durationMs: 9, shell: 'zsh',
    }),
  });

  const out = JSON.parse(await exec(registry, { command: 'gibtsnicht' }));
  assert.equal(out.exit_code, 127);
  assert.equal(out.error, undefined);
  assert.match(out.stderr, /not found/);
});

test('shell_execute meldet Zeitüberschreitung, Abbruch und Kappung als Felder', async () => {
  const basis = { stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: false, truncated: false, durationMs: 1, shell: 'zsh' };

  const zeit = makeRegistry({ run: () => ({ ...basis, timedOut: true, durationMs: 30_000 }) });
  const outZeit = JSON.parse(await exec(zeit.registry, { command: 'sleep 300' }));
  assert.equal(outZeit.timed_out, true);
  assert.match(outZeit.note, /Zeitlimit/);

  const stop = makeRegistry({ run: () => ({ ...basis, aborted: true }) });
  assert.equal(JSON.parse(await exec(stop.registry, { command: 'sleep 300' })).aborted, true);

  const viel = makeRegistry({ run: () => ({ ...basis, stdout: 'x', exitCode: 0, truncated: true }) });
  assert.equal(JSON.parse(await exec(viel.registry, { command: 'cat gross.log' })).truncated, true);
});

test('shell_execute gibt einen Fehler des Runners als Tool-Ergebnis zurück', async () => {
  const { registry } = makeRegistry({ run: () => ({ error: 'Keine Shell gefunden.' }) });
  assert.equal(JSON.parse(await exec(registry, { command: 'ls' })).error, 'Keine Shell gefunden.');
});

test('gesperrte Wirkungen werden mit Begründung abgelehnt — ohne die Shell zu starten', async () => {
  const { registry, calls } = makeRegistry();
  const out = JSON.parse(await exec(registry, { command: 'rm -rf /' }));

  assert.equal(out.blocked, true);
  assert.match(out.error, /Rekursives Zwangslöschen/);
  assert.equal(calls.length, 0);
});

test('der Planer lehnt gesperrte Wirkungen ab, bevor eine Freigabekarte erscheint', async () => {
  const { registry } = makeRegistry();
  const planner = makePlanner(() => ({ label: 'zsh', login: true }));

  const plan = await planner.plan(registry.getDefinition('shell_execute'), { command: 'git push --force' }, {
    workspaceRoot: WORKSPACE,
  });

  assert.match(plan.error, /Git-Historie/);
  assert.equal(plan.reason, 'hard_limit');
});

test('der Planer lehnt einen Arbeitsordner außerhalb des Projektordners ab', async () => {
  const { registry } = makeRegistry();
  const planner = makePlanner(() => ({ label: 'zsh', login: true }));

  const plan = await planner.plan(registry.getDefinition('shell_execute'), { command: 'ls', cwd: '../geheim' }, {
    workspaceRoot: WORKSPACE,
  });

  assert.match(plan.error, /außerhalb/);
  assert.equal(plan.reason, 'hard_limit');
});

test('die Freigabe-Karte bekommt Befehl, Shell und Arbeitsordner', async () => {
  const { registry } = makeRegistry();
  const planner = makePlanner(() => ({ label: 'zsh', login: true }));

  const plan = await planner.plan(registry.getDefinition('shell_execute'), { command: 'npm run build', cwd: 'app' }, {
    workspaceRoot: WORKSPACE,
  });

  assert.deepEqual(plan.riskClasses, ['execute']);
  assert.equal(plan.preview.kind, 'shell');
  assert.equal(plan.preview.text, 'npm run build');
  assert.equal(plan.preview.shell, 'zsh');
  assert.equal(plan.preview.shellLogin, true);
  assert.equal(plan.preview.cwd, nodePath.join(WORKSPACE, 'app'));
});

test('die Karte nennt Shell und Arbeitsordner und warnt vor der fehlenden Grenze', async () => {
  const { buildApprovalCardView, approvalCardTitle, sessionActionHint } = await loadApprovalView();
  const view = buildApprovalCardView({
    contractVersion: 1,
    requestId: 'req-9',
    tool: 'shell_execute',
    riskClasses: ['execute'],
    targets: [],
    mode: 'smart',
    sessionAllowed: false,
    preview: { kind: 'shell', text: 'npm run build', truncated: false, masked: false, shell: 'zsh', shellLogin: true, cwd: '/tmp/projekt/app' },
  });

  assert.equal(view.title, 'Ausführung bestätigen');
  assert.equal(approvalCardTitle(['execute']), 'Ausführung bestätigen');
  assert.equal(view.headline.verb, 'einen Befehl in zsh ausführen');
  assert.equal(view.shellLabel, 'zsh (Login-Shell)');
  assert.equal(view.cwdLabel, '/tmp/projekt/app');
  assert.equal(view.preview.kindLabel, 'Befehl');
  assert.equal(view.preview.text, 'npm run build');
  assert.match(view.warning, /nicht auf den Projektordner begrenzt/);
  // Konzept §6: fuer „Ausfuehren" gibt es nur die Einzelentscheidung.
  assert.equal(view.actions.session.enabled, false);
  assert.match(sessionActionHint({ riskClasses: ['execute'], mode: 'smart' }), /Ausführen/);
});

test('shell_execute hat die Kategorie „exec" und eine deutsche Anzeige-Zeile', () => {
  assert.equal(toolCategory('shell_execute'), TOOL_CATEGORIES.EXEC);
  assert.equal(
    summarizeToolCall('shell_execute', { command: 'git status --short' }, 'start'),
    'Befehl „git status --short“ wird ausgeführt …',
  );
  assert.equal(
    summarizeToolCall('shell_execute', { command: 'npm run build' }, 'done'),
    'Befehl „npm run build“ ausgeführt',
  );
  assert.equal(summarizeToolCall('shell_execute', {}, 'done'), 'Befehl ausgeführt');
});
