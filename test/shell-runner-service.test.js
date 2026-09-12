// Shell-Ausfuehrung im Kindprozess (Issue #102).
//
// Wie beim Python-Runner laufen die Verhaltenstests gegen die echte Shell des
// Rechners — eine Attrappe wuerde genau das nicht pruefen, worum es geht
// (Zeitlimit, Kill des Prozessbaums, Kappung). Die plattformabhaengigen
// Zweige, die sich hier nicht ausfuehren lassen (Windows-taskkill), pruefen
// eine Attrappe und die reinen Funktionen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const {
  createShellRunnerService,
  shellCandidates,
  buildShellArgs,
  clampTimeout,
  INVOCATIONS,
  PROBE_MARKER,
} = require('../src/main/services/shell-runner-service');
const { SHELL_EXECUTION_LIMITS } = require('../src/application/ports/shell-execution-port');

/**
 * Windows-Shells geben CRLF aus, eingecheckte Dateien kommen unter
 * `core.autocrlf` ebenso — fuer die Tests zaehlt der Inhalt, nicht das
 * Zeilenende der Plattform.
 */
function lines(text) {
  return String(text).replace(/\r\n/g, '\n').trim().split('\n');
}

let shared = null;
async function ready() {
  if (!shared) {
    shared = createShellRunnerService({ spawn: childProcess.spawn, os });
    await shared.detect();
  }
  return shared.isAvailable() ? shared : null;
}

/**
 * Dasselbe Vorhaben in der Sprache der jeweiligen Shell. Fehlt eine Variante
 * (cmd.exe kann manches nicht), wird der Test uebersprungen statt geraten.
 */
const COMMANDS = {
  stderr: {
    posix: 'echo hinweis 1>&2',
    powershell: "[Console]::Error.WriteLine('hinweis')",
    cmd: 'echo hinweis 1>&2',
  },
  exitCode: { posix: 'exit 3', powershell: 'exit 3', cmd: 'exit /b 3' },
  cwd: { posix: 'pwd', powershell: '(Get-Location).Path', cmd: 'cd' },
  stdin: {
    posix: 'cat',
    powershell: '[Console]::In.ReadToEnd()',
    cmd: null,
  },
  sleep: { posix: 'sleep 30', powershell: 'Start-Sleep -Seconds 30', cmd: 'timeout /t 30 /nobreak' },
  much: {
    posix: 'awk \'BEGIN { while (i++ < 40000) printf "xxxxxxxxxx" }\'',
    powershell: "Write-Output ('x' * 400000)",
    cmd: null,
  },
};

function commandFor(service, key) {
  const invocation = service.describe().invocation;
  const variants = COMMANDS[key];
  if (invocation === INVOCATIONS.LOGIN || invocation === INVOCATIONS.POSIX) return variants.posix;
  if (invocation === INVOCATIONS.POWERSHELL) return variants.powershell;
  return variants.cmd;
}

// ── Reine Funktionen ─────────────────────────────────────────────────────────

test('shellCandidates kennt die Reihenfolge je Plattform', () => {
  assert.deepEqual(
    shellCandidates('win32').map((c) => c.command),
    ['pwsh.exe', 'powershell.exe', 'cmd.exe'],
  );
  assert.deepEqual(
    shellCandidates('darwin', {}).map((c) => c.command),
    ['/bin/zsh', '/bin/bash', '/bin/sh'],
  );
  assert.deepEqual(
    shellCandidates('linux', {}).map((c) => c.command),
    ['/bin/bash', '/bin/sh'],
  );
});

test('die Login-Shell des Nutzers aus $SHELL kommt zuerst — ohne Doppelung', () => {
  const mitFish = shellCandidates('darwin', { SHELL: '/opt/homebrew/bin/fish' });
  assert.equal(mitFish[0].command, '/opt/homebrew/bin/fish');
  assert.equal(mitFish[0].label, 'fish');
  assert.equal(mitFish.length, 4);

  // $SHELL ist schon in der Fallback-Liste: kein zweiter Eintrag.
  const mitZsh = shellCandidates('darwin', { SHELL: '/bin/zsh' });
  assert.deepEqual(mitZsh.map((c) => c.command), ['/bin/zsh', '/bin/bash', '/bin/sh']);

  // Windows kennt kein $SHELL-Konzept dieser Art.
  assert.deepEqual(
    shellCandidates('win32', { SHELL: '/bin/zsh' }).map((c) => c.command),
    ['pwsh.exe', 'powershell.exe', 'cmd.exe'],
  );
});

test('POSIX-Shells werden zuerst als Login-Shell versucht (PATH aus dem Profil)', () => {
  const [zsh] = shellCandidates('darwin', {});
  assert.deepEqual(zsh.invocations, [INVOCATIONS.LOGIN, INVOCATIONS.POSIX]);
  assert.deepEqual(buildShellArgs(INVOCATIONS.LOGIN, 'git status'), ['-lc', 'git status']);
  assert.deepEqual(buildShellArgs(INVOCATIONS.POSIX, 'git status'), ['-c', 'git status']);
});

test('Windows bekommt den Befehl kodiert statt in Anführungszeichen', () => {
  const args = buildShellArgs(INVOCATIONS.POWERSHELL, 'git commit -m "fix: alles"');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  // Genau dafür: Anführungszeichen überleben die Kommandozeile unbeschadet.
  assert.equal(Buffer.from(args[3], 'base64').toString('utf16le'), 'git commit -m "fix: alles"');

  assert.deepEqual(buildShellArgs(INVOCATIONS.CMD, 'dir /b'), ['/d', '/s', '/c', 'dir /b']);
});

test('clampTimeout hält das Zeitlimit in den Grenzen', () => {
  assert.equal(clampTimeout(undefined), SHELL_EXECUTION_LIMITS.DEFAULT_TIMEOUT_MS);
  assert.equal(clampTimeout('unsinn'), SHELL_EXECUTION_LIMITS.DEFAULT_TIMEOUT_MS);
  assert.equal(clampTimeout(1), SHELL_EXECUTION_LIMITS.MIN_TIMEOUT_MS);
  assert.equal(clampTimeout(9_999_999), SHELL_EXECUTION_LIMITS.MAX_TIMEOUT_MS);
  assert.equal(clampTimeout(45_000), 45_000);
  assert.equal(SHELL_EXECUTION_LIMITS.DEFAULT_TIMEOUT_MS, 30_000);
  assert.equal(SHELL_EXECUTION_LIMITS.MAX_TIMEOUT_MS, 300_000);
});

// ── Attrappe: Zweige, die sich hier nicht ausführen lassen ───────────────────

function fakeChild({ stdout = '', stderr = '', code = 0, autoClose = true } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => { child.killed = true; };
  if (autoClose) {
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
  }
  return child;
}

test('ohne gefundene Shell ist das Tool nicht verfügbar und läuft nicht', async () => {
  const service = createShellRunnerService({
    spawn: () => { throw new Error('keine Shell hier'); },
    os,
    platform: 'linux',
    env: {},
  });
  const detected = await service.detect();

  assert.equal(detected.found, false);
  assert.equal(service.isAvailable(), false);
  assert.match(detected.error, /Keine Shell gefunden/);
  assert.match((await service.run({ command: 'ls' })).error, /Keine Shell/);
});

test('scheitert die Login-Form, wird dieselbe Shell gewöhnlich versucht', async () => {
  const versuche = [];
  const service = createShellRunnerService({
    spawn: (command, args) => {
      versuche.push([command, args[0]]);
      // `-l` nicht unterstuetzt: erst der gewoehnliche Aufruf klappt.
      return fakeChild(args[0] === '-lc' ? { stderr: 'unknown option', code: 2 } : { stdout: PROBE_MARKER });
    },
    os,
    platform: 'linux',
    env: { SHELL: '/bin/dash' },
  });
  const detected = await service.detect();

  assert.deepEqual(versuche, [['/bin/dash', '-lc'], ['/bin/dash', '-c']]);
  assert.equal(detected.found, true);
  assert.equal(detected.command, '/bin/dash');
  assert.equal(detected.login, false);
  assert.equal(detected.invocation, INVOCATIONS.POSIX);
});

test('eine Shell, die den Marker nicht ausgibt, gilt nicht als gefunden', async () => {
  const service = createShellRunnerService({
    spawn: () => fakeChild({ stdout: 'irgendwas anderes', code: 0 }),
    os,
    platform: 'linux',
    env: {},
  });
  assert.equal((await service.detect()).found, false);
});

test('unter Windows beendet das Zeitlimit den ganzen Prozessbaum (taskkill /T)', async () => {
  const aufrufe = [];
  let laufenderBefehl = null;
  const service = createShellRunnerService({
    spawn: (command, args) => {
      aufrufe.push({ command, args });
      if (command === 'taskkill') {
        // Der echte taskkill beendet den Baum; hier endet damit der Lauf.
        setImmediate(() => laufenderBefehl.emit('close', null));
        return fakeChild();
      }
      const child = fakeChild({ stdout: PROBE_MARKER, autoClose: aufrufe.length === 1 });
      if (aufrufe.length > 1) laufenderBefehl = child;
      return child;
    },
    os,
    platform: 'win32',
  });
  await service.detect();
  const result = await service.run({ command: 'Start-Sleep -Seconds 300', timeoutMs: 500 });

  assert.equal(result.timedOut, true);
  assert.equal(result.shell, 'PowerShell 7');
  const kill = aufrufe.find((a) => a.command === 'taskkill');
  assert.ok(kill, 'taskkill muss gerufen werden');
  assert.deepEqual(kill.args, ['/pid', '4242', '/T', '/F']);
});

// ── Echte Shell ──────────────────────────────────────────────────────────────

test('detect findet eine Shell auf diesem Rechner', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');

  const state = service.describe();
  assert.equal(state.found, true);
  assert.ok(state.command, 'die Shell steht im Ergebnis');
  assert.ok(state.label, 'die Shell hat einen Anzeigenamen');
  assert.ok(Object.values(INVOCATIONS).includes(state.invocation));
});

test('run liefert Ausgabe, Fehlerausgabe, Exit-Code und die benutzte Shell', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');

  const result = await service.run({ command: 'echo hallo' });
  assert.deepEqual(lines(result.stdout), ['hallo']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.truncated, false);
  assert.equal(result.shell, service.describe().label);
  assert.equal(typeof result.durationMs, 'number');

  const fehler = await service.run({ command: commandFor(service, 'stderr') });
  assert.deepEqual(lines(fehler.stderr), ['hinweis']);
});

test('ein fehlschlagender Befehl liefert einen Exit-Code statt eines Abbruchs', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');

  const result = await service.run({ command: commandFor(service, 'exitCode') });
  assert.equal(result.exitCode, 3);
  assert.equal(result.error, undefined);

  // Auch ein unbekanntes Programm ist ein gewoehnliches Ergebnis.
  const unbekannt = await service.run({ command: 'snotra-gibt-es-nicht-xyz' });
  assert.equal(unbekannt.error, undefined);
  assert.notEqual(unbekannt.exitCode, 0);
});

test('run arbeitet im übergebenen Verzeichnis', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');
  const command = commandFor(service, 'cwd');
  if (!command) return t.skip('Diese Shell kennt den Befehl nicht.');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-sh-cwd-'));
  try {
    const result = await service.run({ command, cwd: dir });
    assert.match(lines(result.stdout).pop(), new RegExp(`${path.basename(dir)}$`));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run reicht stdin durch und wartet nie auf ein Terminal', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');
  const command = commandFor(service, 'stdin');
  if (!command) return t.skip('Diese Shell kennt den Befehl nicht.');

  const mit = await service.run({ command, stdin: 'hallo welt\n' });
  assert.deepEqual(lines(mit.stdout), ['hallo welt']);

  // Ohne stdin bekommt der Befehl sofort ein Dateiende statt zu haengen.
  const ohne = await service.run({ command, timeoutMs: 5_000 });
  assert.equal(ohne.timedOut, false);
});

test('run beendet einen hängenden Befehl nach dem Zeitlimit', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');

  const started = Date.now();
  const result = await service.run({ command: commandFor(service, 'sleep'), timeoutMs: 1000 });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 15_000, 'darf nicht bis zum Standard-Zeitlimit laufen');
});

test('run bricht bei AbortSignal ab — „Stop" im Chat beendet auch den Befehl', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  const result = await service.run({
    command: commandFor(service, 'sleep'),
    timeoutMs: 60_000,
    abortSignal: controller.signal,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test('run läuft gar nicht erst, wenn schon vorher abgebrochen wurde', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');

  const controller = new AbortController();
  controller.abort();
  const result = await service.run({
    command: commandFor(service, 'sleep'),
    abortSignal: controller.signal,
  });
  assert.equal(result.aborted, true);
});

test('„Stop" beendet den Prozessbaum, nicht nur die Shell', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');
  const state = service.describe();
  if (state.invocation !== INVOCATIONS.LOGIN && state.invocation !== INVOCATIONS.POSIX) {
    return t.skip('Der Enkelprozess-Test ist POSIX-spezifisch; Windows deckt der taskkill-Test ab.');
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-sh-tree-'));
  const marker = path.join(dir, 'enkel.txt');
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    // Ein Enkelprozess, der erst spaeter schreibt: wird nur die Shell
    // beendet, legt er die Datei trotzdem an.
    const result = await service.run({
      command: `(sleep 2; echo da > "${marker}") & wait`,
      timeoutMs: 30_000,
      abortSignal: controller.signal,
    });
    assert.equal(result.aborted, true);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    await assert.rejects(fs.access(marker), 'der Enkelprozess darf nicht weitergelaufen sein');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('run kappt sehr große Ausgaben und sagt es', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');
  const command = commandFor(service, 'much');
  if (!command) return t.skip('Diese Shell kennt den Befehl nicht.');

  const result = await service.run({ command, timeoutMs: 60_000 });
  assert.equal(result.truncated, true);
  assert.match(result.stdout, /\[Ausgabe gekürzt\]$/);
  assert.ok(result.stdout.length < SHELL_EXECUTION_LIMITS.MAX_OUTPUT_BYTES + 200);
});

test('run weist leere und überlange Befehle ab, ohne einen Prozess zu starten', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');

  assert.match((await service.run({ command: '' })).error, /kein Befehl/i);
  assert.match((await service.run({ command: '   ' })).error, /kein Befehl/i);
  assert.match(
    (await service.run({ command: 'x'.repeat(SHELL_EXECUTION_LIMITS.MAX_COMMAND_CHARS + 1) })).error,
    /länger als/,
  );
});

test('gesperrte Wirkungen erreichen die Shell nicht', async (t) => {
  const service = await ready();
  if (!service) return t.skip('Keine Shell auf diesem Rechner.');

  const result = await service.run({ command: 'rm -rf /' });
  assert.equal(result.blocked, true);
  assert.match(result.error, /gesperrt/);
  assert.equal(result.exitCode, undefined);
});
