'use strict';

/**
 * Constants of the shell execution (#102): the bounds of a single run. The
 * shape of a call is the port's business
 * (`application/ports/shell-execution-port.js`, types only); the values live
 * here so that a port file stays a type declaration (#1098).
 */

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
