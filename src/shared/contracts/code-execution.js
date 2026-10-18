'use strict';

/**
 * Constants of the Python execution (#86): the bounds of a single run. The
 * shape of a call is the port's business
 * (`application/ports/code-execution-port.js`, types only); the values live
 * here so that a port file stays a type declaration (#1098).
 */

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
