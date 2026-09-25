'use strict';

/**
 * Shell-Ausfuehrung im Kindprozess (Issue #102).
 *
 * Baugleich zum Python-Runner (#86) — Kindprozess, hartes Zeitlimit, Kill des
 * Prozessbaums, Ausgabe-Kappung, AbortSignal fuer „Stop" im Chat —, nur dass
 * aus der Interpreter-Erkennung eine Shell-Erkennung wird.
 *
 * Isolation (#329): on macOS and Linux the same shell, started the same way,
 * runs under the sandbox service — writes only in the workspace and the run's
 * temp directory, network only for the approved domains. On Windows, or where
 * the sandbox is unavailable, a command can do everything the logged-in user
 * can, and the approval before every run is the protection.
 *
 * Ein Befehl pro Aufruf, kein Zustand: kein dauerhafter Shell-Prozess, kein
 * `cd`, das den naechsten Aufruf beeinflusst. Nicht interaktiv (kein TTY,
 * stdin nur als mitgegebener String) — was auf Eingabe wartet, laeuft ins
 * Zeitlimit statt zu haengen.
 *
 * Dieser Dienst ist zugleich die einzige Stelle, die eine Login-Shell startet
 * (Issue #111): die Erkennung liest dabei den PATH des Nutzers mit und haelt
 * ihn fest, damit auch der Python-Runner ihn bekommt, ohne eine zweite Shell
 * zu starten. Die Erkennung laeuft genau einmal je App-Start — eine Shell
 * kommt und geht nicht zur Laufzeit, und ein Profil-Lauf kostet Zeit.
 */

const { SHELL_EXECUTION_LIMITS } = require('../../application/ports/shell-execution-port');
const { createOutputSink } = require('./child-output-sink');
const { checkShellCommand } = require('../../shared/runtime/shell-command-guard');
const { planSpawn } = require('./sandboxed-spawn');
const { createMessage } = require('../../shared/contracts/message');

/** Marker der Erkennung: die Shell muss ihn tatsaechlich ausgeben. */
const PROBE_MARKER = 'snotra-shell-ok';
/** Praefix der Zeile, in der die POSIX-Erkennung den PATH mitliefert (#111). */
const PATH_MARKER = 'snotra-path=';
const PROBE_COMMAND = `echo ${PROBE_MARKER}`;
/**
 * POSIX-Erkennung: derselbe Marker, danach der PATH. Windows bleibt bewusst
 * beim knappen Befehl — dort kommt der PATH aus Registry und Benutzerumgebung,
 * es gibt nichts zu reparieren (Issue #111).
 */
const PROBE_COMMAND_POSIX = `echo ${PROBE_MARKER}; echo "${PATH_MARKER}$PATH"`;

/**
 * Liest Marker und PATH aus der Ausgabe der Erkennung. Ein Profil darf
 * schwatzen (MOTD, Versionshinweise, Prompt-Vorlauf), deshalb zeilenweise und
 * die letzte PATH-Zeile — vorangehende Ausgabe ist Rauschen.
 */
function parseProbeOutput(text) {
  const out = { marker: false, path: '' };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.includes(PROBE_MARKER)) out.marker = true;
    const at = line.indexOf(PATH_MARKER);
    if (at >= 0) {
      const value = line.slice(at + PATH_MARKER.length).trim();
      if (value) out.path = value;
    }
  }
  return out;
}

/**
 * Aufrufformen. `login` startet eine POSIX-Shell als Login-Shell, damit
 * `.zprofile`/`.bash_profile` den PATH setzen: eine aus dem Finder/Explorer
 * gestartete Electron-App erbt ihn sonst nicht und saehe weder Homebrew noch
 * nvm-Node — obwohl beides im Terminal des Nutzers funktioniert. Kostet
 * Startzeit, ohne sie waere das Tool auf dem Mac aber halb blind.
 *
 * `login-interactive` (`-ilc`) kommt nur bei der Erkennung zum Einsatz
 * (Issue #111): zsh liest `.zshrc` ausschliesslich fuer interaktive Shells,
 * und genau dort stehen PATH-Zeilen bei den meisten Nutzern. Eine reine
 * Login-Shell sieht sie nicht — deshalb war der PATH auch bei `shell_execute`
 * unvollstaendig. Ausgefuehrt werden Befehle weiterhin nicht-interaktiv: ein
 * `.zshrc` mit Prompt-Firlefanz wuerde sonst in jede Befehlsausgabe schreiben.
 */
const INVOCATIONS = Object.freeze({
  LOGIN_INTERACTIVE: 'login-interactive',
  LOGIN: 'login',
  POSIX: 'posix',
  POWERSHELL: 'powershell',
  CMD: 'cmd',
});

/**
 * Argumente fuer eine Aufrufform. Unter Windows geht der Befehl als
 * `-EncodedCommand` (Base64/UTF-16LE) an PowerShell: die Anfuehrungszeichen
 * eines `-Command`-Aufrufs ueberleben die Kommandozeilen-Zerlegung von Node
 * und PowerShell nicht zuverlaessig, `git commit -m "…"` waere sonst kaputt.
 */
function buildShellArgs(invocation, command) {
  if (invocation === INVOCATIONS.POWERSHELL) {
    const encoded = Buffer.from(String(command), 'utf16le').toString('base64');
    return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
  }
  if (invocation === INVOCATIONS.CMD) return ['/d', '/s', '/c', String(command)];
  if (invocation === INVOCATIONS.LOGIN_INTERACTIVE) return ['-ilc', String(command)];
  if (invocation === INVOCATIONS.LOGIN) return ['-lc', String(command)];
  return ['-c', String(command)];
}

/** Anzeigename einer Shell: Programmname ohne Pfad und ohne Endung. */
function shellLabel(command) {
  const base = String(command).split(/[\\/]/).pop() || String(command);
  return base.replace(/\.exe$/i, '');
}

/**
 * Kandidaten in der Reihenfolge, in der wir sie ausprobieren (Issue #102).
 * macOS/Linux: die Login-Shell des Nutzers aus `$SHELL`, danach die ueblichen
 * Verdaechtigen. Windows: PowerShell 7, Windows PowerShell, zuletzt cmd.exe.
 *
 * Je Kandidat eine Liste von Versuchen aus `probe` (womit erkannt wird) und
 * `run` (womit spaeter Befehle laufen). Auf POSIX faellt beides auseinander
 * (Issue #111): erkannt wird moeglichst interaktiv, damit `.zshrc` den PATH
 * beisteuert, ausgefuehrt wird nicht-interaktiv, damit die Ausgabe sauber
 * bleibt. Klappt `-ilc` nicht (exotisches Profil, `sh` ohne `-i`), folgt die
 * reine Login-Shell und zuletzt die gewoehnliche — lieber ein knapper PATH
 * als gar keine Shell.
 */
function shellCandidates(platform, env = {}) {
  if (platform === 'win32') {
    const win = (invocation) => [{ probe: invocation, run: invocation }];
    return [
      { command: 'pwsh.exe', label: 'PowerShell 7', attempts: win(INVOCATIONS.POWERSHELL) },
      { command: 'powershell.exe', label: 'Windows PowerShell', attempts: win(INVOCATIONS.POWERSHELL) },
      { command: 'cmd.exe', label: 'cmd.exe', attempts: win(INVOCATIONS.CMD) },
    ];
  }
  const fallbacks = platform === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : ['/bin/bash', '/bin/sh'];
  const fromEnv = typeof env.SHELL === 'string' ? env.SHELL.trim() : '';
  const seen = new Set();
  const out = [];
  for (const command of [fromEnv, ...fallbacks]) {
    if (!command || seen.has(command)) continue;
    seen.add(command);
    out.push({
      command,
      label: shellLabel(command),
      attempts: [
        { probe: INVOCATIONS.LOGIN_INTERACTIVE, run: INVOCATIONS.LOGIN },
        { probe: INVOCATIONS.LOGIN, run: INVOCATIONS.LOGIN },
        { probe: INVOCATIONS.POSIX, run: INVOCATIONS.POSIX },
      ],
    });
  }
  return out;
}

/** Erkennungsbefehl einer Aufrufform: nur POSIX liefert den PATH mit (#111). */
function probeCommandFor(invocation) {
  return invocation === INVOCATIONS.POWERSHELL || invocation === INVOCATIONS.CMD
    ? PROBE_COMMAND
    : PROBE_COMMAND_POSIX;
}

function clampTimeout(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return SHELL_EXECUTION_LIMITS.DEFAULT_TIMEOUT_MS;
  return Math.min(
    SHELL_EXECUTION_LIMITS.MAX_TIMEOUT_MS,
    Math.max(SHELL_EXECUTION_LIMITS.MIN_TIMEOUT_MS, Math.round(value)),
  );
}

/**
 * @param {Object} deps
 * @param {typeof import('child_process').spawn} deps.spawn
 * @param {typeof import('os')} deps.os
 * @param {string} [deps.platform]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {typeof import('fs/promises')} [deps.fs]  for the run's temp directory (#329)
 * @param {typeof import('path')} [deps.path]
 * @param {object} [deps.sandbox]  sandbox service; without it runs are not isolated (#329)
 */
function createShellRunnerService({
  spawn,
  os,
  platform = process.platform,
  env = process.env,
  fs = null,
  path = null,
  sandbox = null,
}) {
  // Ergebnis der letzten Erkennung. Synchron abrufbar, weil die Tool-Liste
  // ohne Warten gebaut wird.
  // `error` is the detail Settings shows next to "No shell found": a
  // catalogue message, or the quoted output of the probe (#338). The model
  // never reads it — `run()` has its own English sentence.
  let detected = { found: false, error: createMessage('runner.error.notChecked') };

  function probe(command, invocation) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, buildShellArgs(invocation, probeCommandFor(invocation)), {
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
      } catch (e) {
        resolve({ ok: false, error: e?.message || createMessage('runner.error.startFailed') });
        return;
      }
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* schon weg */ }
        resolve({ ok: false, error: createMessage('runner.error.probeTimeout') });
      }, SHELL_EXECUTION_LIMITS.PROBE_TIMEOUT_MS);
      child.stdout?.on('data', (c) => { out += String(c); });
      child.stderr?.on('data', (c) => { err += String(c); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: e?.message || createMessage('runner.error.notFound') });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Ein Login-Profil darf schwatzen (MOTD, Versionshinweise) — es zaehlt
        // nur, dass der Marker wirklich aus der Shell kommt.
        const parsed = parseProbeOutput(out);
        if (code === 0 && parsed.marker) resolve({ ok: true, path: parsed.path });
        else resolve({ ok: false, error: err.trim().split('\n')[0] || createMessage('runner.error.exitCode', { code }) });
      });
    });
  }

  /**
   * Sucht eine Shell und liest dabei den PATH des Nutzers mit. Scheitert ein
   * Versuch (exotisches Profil, `-i` oder `-l` nicht unterstuetzt), kommt die
   * naechste Aufrufform derselben Shell dran, bevor die naechste Shell
   * probiert wird — lieber ein knapper PATH als gar keine Shell.
   */
  async function runDetection() {
    let firstError = '';
    for (const candidate of shellCandidates(platform, env)) {
      for (const attempt of candidate.attempts) {
        const result = await probe(candidate.command, attempt.probe);
        if (result.ok) {
          detected = {
            found: true,
            command: candidate.command,
            label: candidate.label,
            invocation: attempt.run,
            login: attempt.run === INVOCATIONS.LOGIN,
            // Womit erkannt wurde, gehoert ins Ergebnis: nur die interaktive
            // Form sieht `.zshrc`, und genau das macht den Unterschied im PATH.
            probeInvocation: attempt.probe,
            interactive: attempt.probe === INVOCATIONS.LOGIN_INTERACTIVE,
            path: result.path || '',
          };
          return detected;
        }
        if (!firstError && result.error) firstError = result.error;
      }
    }
    detected = {
      found: false,
      error: createMessage(firstError ? 'runner.error.triedWithDetail' : 'runner.error.tried', {
        ...(platform === 'win32'
          ? { candidates: 'pwsh.exe, powershell.exe, cmd.exe' }
          : { candidatesKey: 'runner.shell.posixCandidates' }),
        ...(firstError ? { detail: firstError } : {}),
      }),
    };
    return detected;
  }

  // Genau ein Profil-Lauf je App-Start (Issue #111). Die Einstellungen rufen
  // `detect()` bei jedem Speichern, und der Python-Runner haengt sich an
  // dasselbe Versprechen — ohne diesen Merker startete bei jedem Klick eine
  // neue Login-Shell. An der Erkennung gibt es nichts zu aktualisieren: eine
  // Shell kommt zur Laufzeit weder dazu noch weg.
  let detection = null;
  function detect() {
    if (!detection) detection = runDetection();
    return detection;
  }

  /**
   * Umgebung fuer Kindprozesse: der bei der Erkennung gelesene PATH schlaegt
   * den kargen PATH einer aus dem Finder gestarteten App (Issue #111). Ohne
   * gelesenen PATH (Windows, gescheiterte Erkennung) bleibt alles beim Alten.
   */
  function childEnv() {
    return detected.path ? { ...env, PATH: detected.path } : env;
  }

  /** Prozessbaum beenden — ein Befehl startet fast immer eigene Kinder. */
  function killTree(child) {
    if (!child || child.killed) return;
    try {
      if (platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      try { child.kill('SIGKILL'); } catch { /* schon weg */ }
    }
  }

  async function run({ command, stdin, timeoutMs, cwd, workspaceRoot, networkDomains, sandboxDisabled = false, abortSignal } = {}) {
    if (!detected.found) {
      return { error: 'No shell is available.' };
    }
    const line = typeof command === 'string' ? command : '';
    if (!line.trim()) return { error: 'No command was given.' };
    if (line.length > SHELL_EXECUTION_LIMITS.MAX_COMMAND_CHARS) {
      return { error: `The command is longer than ${SHELL_EXECUTION_LIMITS.MAX_COMMAND_CHARS} characters.` };
    }
    // Zweite Verteidigungslinie hinter der Freigabe (Konzept §9): der Planer
    // lehnt gesperrte Wirkungen schon vor der Karte ab, der Runner noch einmal
    // fuer jeden Weg, der nicht ueber den Planer laeuft.
    const guard = checkShellCommand(line);
    if (guard.blocked) return { error: guard.reason, blocked: true };

    const limit = clampTimeout(timeoutMs);
    const startedAt = Date.now();
    const stdout = createOutputSink(SHELL_EXECUTION_LIMITS.MAX_OUTPUT_BYTES);
    const stderr = createOutputSink(SHELL_EXECUTION_LIMITS.MAX_OUTPUT_BYTES);

    // Isolation (#329): besides the workspace, the run's own temp directory
    // is the only place it may write to; caches are redirected there too.
    // Switched off for this workspace (#357), the run needs none of that.
    const runTmp = sandbox && !sandboxDisabled && fs && path
      ? await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-sh-'))
      : '';
    const removeRunTmp = () => (runTmp ? fs.rm(runTmp, { recursive: true, force: true }).catch(() => {}) : undefined);
    let target;
    try {
      target = await planSpawn({
        sandbox: runTmp ? sandbox : null,
        disabled: sandboxDisabled === true,
        argv: [detected.command, ...buildShellArgs(detected.invocation, line)],
        workspaceRoot,
        runTmp,
        domains: networkDomains,
        commandId: `shell-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        commandText: line,
        abortSignal,
      });
    } catch (e) {
      await removeRunTmp();
      if (e?.name === 'AbortError') {
        return {
          stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true,
          truncated: false, durationMs: Date.now() - startedAt, shell: detected.label,
        };
      }
      return { error: e?.message || 'The sandbox could not be prepared.' };
    }

    try {
      return await spawnAndCollect(target);
    } finally {
      target.release();
      await removeRunTmp();
    }

    function spawnAndCollect(target) {
      return new Promise((resolve) => {
        let child;
        try {
          child = spawn(target.command, target.args, {
            cwd: cwd || os.homedir(),
            stdio: ['pipe', 'pipe', 'pipe'],
            // Eigene Prozessgruppe, damit killTree auch Enkelprozesse erwischt.
            detached: platform !== 'win32',
            env: { ...childEnv(), ...target.env },
          });
        } catch (e) {
          resolve({ error: e?.message || 'The shell could not be started.' });
          return;
        }

        let timedOut = false;
        let aborted = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, limit);

        const onAbort = () => {
          aborted = true;
          killTree(child);
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });

        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);
          resolve(result);
        };

        child.stdout?.on('data', (chunk) => stdout.push(chunk));
        child.stderr?.on('data', (chunk) => stderr.push(chunk));
        child.on('error', (e) => finish({ error: e?.message || 'The shell could not be started.' }));
        child.on('close', (exitCode) => {
          const result = {
            stdout: stdout.text(),
            // What the sandbox refused goes to the model with the output (#329).
            stderr: target.annotate(stderr.text()),
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            timedOut,
            aborted,
            truncated: stdout.truncated || stderr.truncated,
            durationMs: Date.now() - startedAt,
            shell: detected.label,
          };
          if (target.isolation) result.isolation = target.isolation;
          finish(result);
        });

        // Kein TTY: was auf eine Eingabe wartet, bekommt hoechstens den
        // mitgegebenen String und sonst ein Dateiende.
        if (typeof stdin === 'string' && stdin) {
          child.stdin?.end(stdin.slice(0, SHELL_EXECUTION_LIMITS.MAX_STDIN_CHARS));
        } else {
          child.stdin?.end();
        }
        if (abortSignal?.aborted) onAbort();
      });
    }
  }

  return {
    detect,
    describe: () => ({ ...detected }),
    isAvailable: () => detected.found === true,
    run,
  };
}

module.exports = {
  createShellRunnerService,
  shellCandidates,
  buildShellArgs,
  shellLabel,
  clampTimeout,
  parseProbeOutput,
  probeCommandFor,
  INVOCATIONS,
  PROBE_MARKER,
  PATH_MARKER,
};
