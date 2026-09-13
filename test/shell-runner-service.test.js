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
  parseProbeOutput,
  probeCommandFor,
  INVOCATIONS,
  PROBE_MARKER,
  PATH_MARKER,
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

test('POSIX-Shells werden interaktiv erkannt, aber nicht-interaktiv ausgeführt (#111)', () => {
  const [zsh] = shellCandidates('darwin', {});
  // Erkannt wird moeglichst interaktiv — nur so liest zsh die `.zshrc`, in der
  // die meisten ihren PATH setzen. Ausgefuehrt wird trotzdem nicht-interaktiv,
  // sonst landet Prompt-Ausgabe in jedem Befehlsergebnis.
  assert.deepEqual(zsh.attempts, [
    { probe: INVOCATIONS.LOGIN_INTERACTIVE, run: INVOCATIONS.LOGIN },
    { probe: INVOCATIONS.LOGIN, run: INVOCATIONS.LOGIN },
    { probe: INVOCATIONS.POSIX, run: INVOCATIONS.POSIX },
  ]);
  assert.deepEqual(buildShellArgs(INVOCATIONS.LOGIN_INTERACTIVE, 'git status'), ['-ilc', 'git status']);
  assert.deepEqual(buildShellArgs(INVOCATIONS.LOGIN, 'git status'), ['-lc', 'git status']);
  assert.deepEqual(buildShellArgs(INVOCATIONS.POSIX, 'git status'), ['-c', 'git status']);
});

test('nur die POSIX-Erkennung fragt nach dem PATH, Windows nicht (#111)', () => {
  assert.match(probeCommandFor(INVOCATIONS.LOGIN_INTERACTIVE), /snotra-path=\$PATH/);
  assert.match(probeCommandFor(INVOCATIONS.POSIX), /snotra-path=\$PATH/);
  // Unter Windows gibt es nichts zu reparieren: der PATH kommt aus der
  // Registry, nicht aus einem Profil. Der Befehl bleibt der von #102.
  assert.equal(probeCommandFor(INVOCATIONS.POWERSHELL), `echo ${PROBE_MARKER}`);
  assert.equal(probeCommandFor(INVOCATIONS.CMD), `echo ${PROBE_MARKER}`);
});

test('parseProbeOutput findet den PATH auch in geschwätzigen Profilen (#111)', () => {
  const out = parseProbeOutput(
    ['Letzte Anmeldung: Fr 13 Sep', PROBE_MARKER, `${PATH_MARKER}/opt/homebrew/bin:/usr/bin`].join('\n'),
  );
  assert.equal(out.marker, true);
  assert.equal(out.path, '/opt/homebrew/bin:/usr/bin');

  // Ohne Marker gilt die Shell nicht als gefunden, auch mit PATH-Zeile.
  assert.equal(parseProbeOutput(`${PATH_MARKER}/usr/bin`).marker, false);
  // Eine leere PATH-Zeile ist kein PATH.
  assert.equal(parseProbeOutput(`${PROBE_MARKER}\n${PATH_MARKER}`).path, '');
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

test('scheitern die Profil-Formen, wird dieselbe Shell gewöhnlich versucht', async () => {
  const versuche = [];
  const service = createShellRunnerService({
    spawn: (command, args) => {
      versuche.push([command, args[0]]);
      // Weder `-i` noch `-l` unterstuetzt: erst der gewoehnliche Aufruf klappt.
      return fakeChild(args[0] === '-c' ? { stdout: PROBE_MARKER } : { stderr: 'unknown option', code: 2 });
    },
    os,
    platform: 'linux',
    env: { SHELL: '/bin/dash' },
  });
  const detected = await service.detect();

  assert.deepEqual(versuche, [['/bin/dash', '-ilc'], ['/bin/dash', '-lc'], ['/bin/dash', '-c']]);
  assert.equal(detected.found, true);
  assert.equal(detected.command, '/bin/dash');
  assert.equal(detected.login, false);
  assert.equal(detected.invocation, INVOCATIONS.POSIX);
  // Ohne Profil-Lauf gibt es keinen PATH zu uebernehmen (Issue #111).
  assert.equal(detected.path, '');
});

test('die interaktive Login-Shell liefert den PATH, Befehle laufen ohne -i (#111)', async () => {
  const versuche = [];
  const service = createShellRunnerService({
    spawn: (command, args) => {
      versuche.push(args[0]);
      return fakeChild({ stdout: `${PROBE_MARKER}\n${PATH_MARKER}/opt/homebrew/bin:/usr/bin\n` });
    },
    os,
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
  });
  const detected = await service.detect();

  assert.deepEqual(versuche, ['-ilc'], 'genau ein Profil-Lauf');
  assert.equal(detected.path, '/opt/homebrew/bin:/usr/bin');
  assert.equal(detected.interactive, true);
  assert.equal(detected.login, true);
  // Erkannt interaktiv, ausgefuehrt nicht — sonst schreibt ein geschwaetziges
  // `.zshrc` in jede Befehlsausgabe.
  assert.equal(detected.invocation, INVOCATIONS.LOGIN);
  assert.equal(detected.probeInvocation, INVOCATIONS.LOGIN_INTERACTIVE);
});

test('der gelesene PATH geht an jeden Befehl (#111)', async () => {
  let laufEnv = null;
  const service = createShellRunnerService({
    spawn: (command, args, options) => {
      if (args[0] !== '-ilc') laufEnv = options?.env;
      return fakeChild({ stdout: `${PROBE_MARKER}\n${PATH_MARKER}/opt/homebrew/bin:/usr/bin\n` });
    },
    os,
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: '/Users/test' },
  });
  await service.detect();
  await service.run({ command: 'git status' });

  assert.equal(laufEnv.PATH, '/opt/homebrew/bin:/usr/bin');
  // Der Rest der Umgebung bleibt unangetastet.
  assert.equal(laufEnv.HOME, '/Users/test');
});

test('die Erkennung startet höchstens eine Login-Shell je App-Start (#111)', async () => {
  let laeufe = 0;
  const service = createShellRunnerService({
    spawn: () => {
      laeufe += 1;
      return fakeChild({ stdout: `${PROBE_MARKER}\n${PATH_MARKER}/opt/homebrew/bin\n` });
    },
    os,
    platform: 'darwin',
    env: { SHELL: '/bin/zsh' },
  });

  // Die Einstellungen rufen detect() bei jedem Speichern, der Python-Runner
  // haengt sich an denselben Lauf — ein Profil-Lauf kostet Zeit.
  const [a, b] = await Promise.all([service.detect(), service.detect()]);
  await service.detect();

  assert.equal(laeufe, 1);
  assert.equal(a.path, '/opt/homebrew/bin');
  assert.equal(b.path, '/opt/homebrew/bin');
});

test('unter Windows bleibt die Erkennung ohne Profil-Lauf (#111)', async () => {
  const versuche = [];
  const service = createShellRunnerService({
    spawn: (command, args, options) => {
      versuche.push({ command, args, env: options?.env });
      return fakeChild({ stdout: PROBE_MARKER });
    },
    os,
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\system32' },
  });
  const detected = await service.detect();

  assert.equal(detected.path, '', 'kein Profil-PATH unter Windows');
  assert.equal(detected.interactive, false);
  // Unveraendert gegenueber #102: -NoProfile, kein -i, kein -l.
  assert.equal(versuche[0].args[0], '-NoProfile');
  assert.equal(versuche[0].env.PATH, 'C:\\Windows\\system32');
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

  // Auch ein unbekanntes Programm ist ein gewoehnliches Ergebnis. Wie eine
  // Shell das meldet, ist ihre Sache — Exit-Code oder Fehlerausgabe; ein
  // Abbruch im Chat darf es jedenfalls nicht sein.
  const unbekannt = await service.run({ command: 'snotra-gibt-es-nicht-xyz' });
  assert.equal(unbekannt.error, undefined);
  assert.ok(
    unbekannt.exitCode !== 0 || unbekannt.stderr.trim() !== '',
    'der Fehlschlag ist am Exit-Code oder an der Fehlerausgabe erkennbar',
  );
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
