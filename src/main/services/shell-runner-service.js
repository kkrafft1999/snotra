'use strict';

/**
 * Shell-Ausfuehrung im Kindprozess (Issue #102).
 *
 * Baugleich zum Python-Runner (#86) — Kindprozess, hartes Zeitlimit, Kill des
 * Prozessbaums, Ausgabe-Kappung, AbortSignal fuer „Stop" im Chat —, nur dass
 * aus der Interpreter-Erkennung eine Shell-Erkennung wird. Bewusst ohne harte
 * Isolation: der Schutz liegt in der Freigabe vor jedem Lauf, nicht in einer
 * Sandbox. Ein Befehl kann alles, was der angemeldete Nutzer kann.
 *
 * Ein Befehl pro Aufruf, kein Zustand: kein dauerhafter Shell-Prozess, kein
 * `cd`, das den naechsten Aufruf beeinflusst. Nicht interaktiv (kein TTY,
 * stdin nur als mitgegebener String) — was auf Eingabe wartet, laeuft ins
 * Zeitlimit statt zu haengen.
 */

const { SHELL_EXECUTION_LIMITS } = require('../../application/ports/shell-execution-port');
const { createOutputSink } = require('./child-output-sink');
const { checkShellCommand } = require('../../shared/runtime/shell-command-guard');

/** Marker der Erkennung: die Shell muss ihn tatsaechlich ausgeben. */
const PROBE_MARKER = 'snotra-shell-ok';
const PROBE_COMMAND = `echo ${PROBE_MARKER}`;

/**
 * Aufrufformen. `login` startet eine POSIX-Shell als Login-Shell, damit
 * `.zprofile`/`.bash_profile` den PATH setzen: eine aus dem Finder/Explorer
 * gestartete Electron-App erbt ihn sonst nicht und saehe weder Homebrew noch
 * nvm-Node — obwohl beides im Terminal des Nutzers funktioniert. Kostet
 * Startzeit, ohne sie waere das Tool auf dem Mac aber halb blind.
 */
const INVOCATIONS = Object.freeze({
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
 */
function shellCandidates(platform, env = {}) {
  if (platform === 'win32') {
    return [
      { command: 'pwsh.exe', label: 'PowerShell 7', invocations: [INVOCATIONS.POWERSHELL] },
      { command: 'powershell.exe', label: 'Windows PowerShell', invocations: [INVOCATIONS.POWERSHELL] },
      { command: 'cmd.exe', label: 'cmd.exe', invocations: [INVOCATIONS.CMD] },
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
    // Erst als Login-Shell (PATH aus dem Profil), sonst gewoehnlich.
    out.push({ command, label: shellLabel(command), invocations: [INVOCATIONS.LOGIN, INVOCATIONS.POSIX] });
  }
  return out;
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
 */
function createShellRunnerService({ spawn, os, platform = process.platform, env = process.env }) {
  // Ergebnis der letzten Erkennung. Synchron abrufbar, weil die Tool-Liste
  // ohne Warten gebaut wird.
  let detected = { found: false, error: 'Noch nicht geprüft.' };

  function probe(command, invocation) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, buildShellArgs(invocation, PROBE_COMMAND), {
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
      } catch (e) {
        resolve({ ok: false, error: e?.message || 'Start fehlgeschlagen.' });
        return;
      }
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* schon weg */ }
        resolve({ ok: false, error: 'Zeitüberschreitung bei der Shell-Erkennung.' });
      }, SHELL_EXECUTION_LIMITS.PROBE_TIMEOUT_MS);
      child.stdout?.on('data', (c) => { out += String(c); });
      child.stderr?.on('data', (c) => { err += String(c); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: e?.message || 'Shell nicht gefunden.' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Ein Login-Profil darf schwatzen (MOTD, Versionshinweise) — es zaehlt
        // nur, dass der Marker wirklich aus der Shell kommt.
        if (code === 0 && out.includes(PROBE_MARKER)) resolve({ ok: true });
        else resolve({ ok: false, error: err.trim().split('\n')[0] || `Beendet mit Code ${code}.` });
      });
    });
  }

  /**
   * Sucht eine Shell. Scheitert die Login-Form (exotisches Profil, `-l` nicht
   * unterstuetzt), wird dieselbe Shell gewoehnlich versucht, bevor die
   * naechste drankommt — lieber ein knapper PATH als gar keine Shell.
   */
  async function detect() {
    let firstError = '';
    for (const candidate of shellCandidates(platform, env)) {
      for (const invocation of candidate.invocations) {
        const result = await probe(candidate.command, invocation);
        if (result.ok) {
          detected = {
            found: true,
            command: candidate.command,
            label: candidate.label,
            invocation,
            login: invocation === INVOCATIONS.LOGIN,
          };
          return detected;
        }
        if (!firstError && result.error) firstError = result.error;
      }
    }
    detected = {
      found: false,
      error: platform === 'win32'
        ? `Keine Shell gefunden (weder „pwsh.exe“ noch „powershell.exe“ noch „cmd.exe“)${firstError ? `: ${firstError}` : '.'}`
        : `Keine Shell gefunden (weder „$SHELL“ noch die üblichen Pfade)${firstError ? `: ${firstError}` : '.'}`,
    };
    return detected;
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

  async function run({ command, stdin, timeoutMs, cwd, abortSignal } = {}) {
    if (!detected.found) {
      return { error: detected.error || 'Keine Shell gefunden.' };
    }
    const line = typeof command === 'string' ? command : '';
    if (!line.trim()) return { error: 'Es wurde kein Befehl übergeben.' };
    if (line.length > SHELL_EXECUTION_LIMITS.MAX_COMMAND_CHARS) {
      return { error: `Der Befehl ist länger als ${SHELL_EXECUTION_LIMITS.MAX_COMMAND_CHARS} Zeichen.` };
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

    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn(detected.command, buildShellArgs(detected.invocation, line), {
          cwd: cwd || os.homedir(),
          stdio: ['pipe', 'pipe', 'pipe'],
          // Eigene Prozessgruppe, damit killTree auch Enkelprozesse erwischt.
          detached: platform !== 'win32',
          env,
        });
      } catch (e) {
        resolve({ error: e?.message || 'Die Shell konnte nicht gestartet werden.' });
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
      child.on('error', (e) => finish({ error: e?.message || 'Die Shell konnte nicht gestartet werden.' }));
      child.on('close', (exitCode) => {
        finish({
          stdout: stdout.text(),
          stderr: stderr.text(),
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          timedOut,
          aborted,
          truncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - startedAt,
          shell: detected.label,
        });
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
  INVOCATIONS,
  PROBE_MARKER,
};
