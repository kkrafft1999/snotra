/**
 * Shell-Ausfuehrungs-Port (Issue #102).
 *
 * Neben dem `code-execution-port` die zweite Ausfuehrungsfaehigkeit — und die
 * weitreichendere: ein Shell-Befehl kann alles, was der angemeldete Nutzer
 * kann. Es gibt keine Workspace-Grenze, keine Sandbox und kein
 * Schutzversprechen durch Musterlisten; der Schutz ist der sichtbare Befehl
 * plus Freigabe vor jedem einzelnen Lauf (Konzept §9, mit diesem Issue
 * bewusst revidiert).
 *
 * Wie beim Code-Port bleibt die Oberflaeche eng: ein Befehl rein, Ausgabe und
 * Exit-Code raus, kein Zustand zwischen zwei Aufrufen. Kein dauerhafter
 * Shell-Prozess, kein `cd`, das den naechsten Aufruf beeinflusst.
 *
 * @typedef {Object} ShellExecutionResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number|null} exitCode  null, wenn der Prozess per Signal endete
 * @property {boolean} timedOut
 * @property {boolean} aborted       durch „Stop" im Chat beendet
 * @property {boolean} truncated     Ausgabe wurde gekappt
 * @property {number} durationMs
 * @property {string} shell          Anzeigename der tatsaechlich benutzten Shell
 *
 * @typedef {Object} ShellDescription
 * @property {boolean} found
 * @property {string} [command]      Programmpfad der Shell
 * @property {string} [label]        Anzeigename („zsh", „PowerShell 7")
 * @property {string} [invocation]   Aufrufform (siehe shell-runner-service)
 * @property {boolean} [login]       POSIX-Shell als Login-Shell gestartet (PATH aus dem Profil)
 * @property {string} [error]
 *
 * @typedef {Object} ShellExecutionPort
 * @property {() => boolean} isAvailable
 *   Ob eine Shell gefunden und die Ausfuehrung eingeschaltet ist. Synchron,
 *   weil die Tool-Sichtbarkeit beim Bauen der Tool-Liste feststehen muss.
 * @property {() => ShellDescription} describe
 * @property {(request: { command: string, stdin?: string, timeoutMs?: number,
 *   cwd?: string, abortSignal?: AbortSignal }) => Promise<ShellExecutionResult>} run
 */

'use strict';

const SHELL_EXECUTION_LIMITS = Object.freeze({
  /** Builds und Testlaeufe dauern laenger als ein Python-Schnipsel (Issue #102). */
  DEFAULT_TIMEOUT_MS: 30_000,
  MAX_TIMEOUT_MS: 300_000,
  MIN_TIMEOUT_MS: 500,
  /** Je Strom (stdout/stderr) — danach wird gekappt und der Rest verworfen. */
  MAX_OUTPUT_BYTES: 200_000,
  /** Eine Kommandozeile, kein Skript; cmd.exe kann ohnehin nicht mehr. */
  MAX_COMMAND_CHARS: 8_000,
  MAX_STDIN_CHARS: 200_000,
  /** Erkennung beim Start: eine Login-Shell liest Profile und braucht Luft. */
  PROBE_TIMEOUT_MS: 10_000,
});

module.exports = { SHELL_EXECUTION_LIMITS };
