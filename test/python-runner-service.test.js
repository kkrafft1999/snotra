// Python-Ausfuehrung im Kindprozess (Issue #86).
//
// Die Tests nutzen den echten Interpreter des Rechners, wenn einer da ist —
// eine Attrappe wuerde genau das nicht pruefen, worum es geht (Zeitlimit,
// Kill des Prozessbaums, Kappung). Ohne Python wird uebersprungen statt
// rot: die CI-Runner haben Python, ein fremder Rechner vielleicht nicht.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { createPythonRunnerService, interpreterCandidates, clampTimeout } =
  require('../src/main/services/python-runner-service');
const { PYTHON_EXECUTION_LIMITS } = require('../src/application/ports/code-execution-port');

function makeService(overrides = {}) {
  return createPythonRunnerService({ spawn: childProcess.spawn, fs, path, os, ...overrides });
}

let shared = null;
async function ready() {
  if (!shared) {
    shared = makeService();
    await shared.detect();
  }
  return shared.isAvailable() ? shared : null;
}

test('interpreterCandidates kennt die Reihenfolge je Plattform', () => {
  assert.deepEqual(
    interpreterCandidates('win32').map((c) => `${c.command} ${c.args.join(' ')}`.trim()),
    ['py -3', 'python', 'python3'],
  );
  assert.deepEqual(
    interpreterCandidates('darwin').map((c) => c.command),
    ['python3', 'python'],
  );
});

test('clampTimeout hält das Zeitlimit in den Grenzen', () => {
  assert.equal(clampTimeout(undefined), PYTHON_EXECUTION_LIMITS.DEFAULT_TIMEOUT_MS);
  assert.equal(clampTimeout('unsinn'), PYTHON_EXECUTION_LIMITS.DEFAULT_TIMEOUT_MS);
  assert.equal(clampTimeout(1), PYTHON_EXECUTION_LIMITS.MIN_TIMEOUT_MS);
  assert.equal(clampTimeout(9_999_999), PYTHON_EXECUTION_LIMITS.MAX_TIMEOUT_MS);
  assert.equal(clampTimeout(3000), 3000);
});

test('ohne gefundenen Interpreter ist das Tool nicht verfügbar und läuft nicht', async () => {
  const service = makeService({
    spawn: () => { throw new Error('kein python hier'); },
    platform: 'linux',
  });
  const detected = await service.detect();

  assert.equal(detected.found, false);
  assert.equal(service.isAvailable(), false);
  assert.match(detected.error, /Kein Python 3/);

  const result = await service.run({ code: 'print(1)' });
  assert.match(result.error, /Kein Python/);
});

test('ein hinterlegter Interpreter, der nicht startet, fällt nicht still auf python3 zurück', async () => {
  const service = makeService({
    spawn: () => { throw new Error('ENOENT'); },
    readInterpreterOverride: async () => '/pfad/zu/venv/bin/python3',
  });
  const detected = await service.detect();

  assert.equal(detected.found, false);
  assert.equal(detected.source, 'override');
  assert.equal(detected.command, '/pfad/zu/venv/bin/python3');
});

test('detect findet Python 3 auf diesem Rechner', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const state = service.describe();
  assert.equal(state.found, true);
  assert.match(state.version, /Python 3/);
});

test('run liefert Ausgabe, Fehlerausgabe und Exit-Code', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const result = await service.run({
    code: 'import sys\nprint(sum(range(101)))\nprint("hinweis", file=sys.stderr)\nsys.exit(0)',
  });

  assert.equal(result.stdout.trim(), '5050');
  assert.equal(result.stderr.trim(), 'hinweis');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(typeof result.durationMs, 'number');
});

test('run meldet einen Exit-Code ungleich 0 samt Traceback, statt zu werfen', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const result = await service.run({ code: 'raise ValueError("kaputt")' });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /ValueError: kaputt/);
});

test('run reicht stdin und argv durch', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const result = await service.run({
    code: 'import sys\nprint(sys.stdin.read().strip().upper())\nprint(",".join(sys.argv[1:]))',
    stdin: 'hallo welt\n',
    argv: ['a', 'b'],
  });

  assert.equal(result.stdout.trim().split('\n')[0], 'HALLO WELT');
  assert.equal(result.stdout.trim().split('\n')[1], 'a,b');
});

test('run arbeitet im übergebenen Verzeichnis', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-cwd-'));
  await fs.writeFile(path.join(dir, 'daten.csv'), 'a,b\n1,2\n', 'utf8');
  try {
    const result = await service.run({ code: 'print(open("daten.csv").read().strip())', cwd: dir });
    assert.equal(result.stdout.trim(), 'a,b\n1,2');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run beendet eine Endlosschleife nach dem Zeitlimit', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const started = Date.now();
  const result = await service.run({ code: 'while True:\n    pass', timeoutMs: 1000 });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 8000, 'darf nicht bis zum Standard-Zeitlimit laufen');
});

test('run bricht bei AbortSignal ab — „Stop" im Chat beendet auch das Skript', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  const result = await service.run({
    code: 'import time\ntime.sleep(30)',
    timeoutMs: 60_000,
    abortSignal: controller.signal,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test('run läuft gar nicht erst, wenn schon vorher abgebrochen wurde', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const controller = new AbortController();
  controller.abort();
  const result = await service.run({ code: 'import time\ntime.sleep(30)', abortSignal: controller.signal });

  assert.equal(result.aborted, true);
});

test('run kappt sehr große Ausgaben und sagt es', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const result = await service.run({
    code: 'print("x" * 2_000_000)',
    timeoutMs: 30_000,
  });

  assert.equal(result.truncated, true);
  assert.match(result.stdout, /\[Ausgabe gekürzt\]$/);
  assert.ok(result.stdout.length < PYTHON_EXECUTION_LIMITS.MAX_OUTPUT_BYTES + 200);
});

test('run weist leeren und überlangen Code ab, ohne einen Prozess zu starten', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  assert.match((await service.run({ code: '' })).error, /kein Python-Code/i);
  assert.match((await service.run({ code: '   ' })).error, /kein Python-Code/i);
  assert.match(
    (await service.run({ code: 'x'.repeat(PYTHON_EXECUTION_LIMITS.MAX_CODE_CHARS + 1) })).error,
    /länger als/,
  );
});

test('run hinterlässt keine Skriptdatei im Arbeitsverzeichnis', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Kein Python 3 auf diesem Rechner.');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-clean-'));
  try {
    await service.run({ code: 'print(1)', cwd: dir });
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
