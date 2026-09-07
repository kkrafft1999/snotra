/**
 * Code-Ausfuehrungs-Port (Issue #86).
 *
 * Ausgefuehrter Code ist qualitativ etwas anderes als die Datei-Tools: er
 * umgeht die Workspace-Grenze grundsaetzlich, weil nicht Snotra die
 * Dateizugriffe macht, sondern der Interpreter. Der Port bleibt deshalb
 * bewusst eng — ein Programm rein, Ausgabe und Exit-Code raus, kein Zustand
 * zwischen zwei Aufrufen.
 *
 * @typedef {Object} CodeExecutionResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number|null} exitCode  null, wenn der Prozess per Signal endete
 * @property {boolean} timedOut
 * @property {boolean} aborted       durch „Stop" im Chat beendet
 * @property {boolean} truncated     Ausgabe wurde gekappt
 * @property {number} durationMs
 *
 * @typedef {Object} CodeExecutionPort
 * @property {() => boolean} isAvailable
 *   Ob ein Interpreter gefunden wurde. Synchron, weil die Tool-Sichtbarkeit
 *   beim Bauen der Tool-Liste feststehen muss.
 * @property {() => { found: boolean, command?: string, version?: string, error?: string }} describe
 * @property {(request: { code: string, stdin?: string, argv?: string[], timeoutMs?: number,
 *   cwd?: string, abortSignal?: AbortSignal }) => Promise<CodeExecutionResult>} run
 */

'use strict';

const PYTHON_EXECUTION_LIMITS = Object.freeze({
  DEFAULT_TIMEOUT_MS: 10_000,
  MAX_TIMEOUT_MS: 120_000,
  MIN_TIMEOUT_MS: 500,
  /** Je Strom (stdout/stderr) — danach wird gekappt und der Rest verworfen. */
  MAX_OUTPUT_BYTES: 200_000,
  MAX_CODE_CHARS: 200_000,
  MAX_STDIN_CHARS: 200_000,
  MAX_ARGV: 32,
  MAX_ARGV_CHARS: 4_000,
});

module.exports = { PYTHON_EXECUTION_LIMITS };
