'use strict';

/**
 * The local log file (#978). Main logged to `console` only, so in the field —
 * where nobody starts Snotra from a terminal — every warning and every error
 * outside a chat run was gone the moment it was written, and the start-up
 * error box pointed to a log that did not exist.
 *
 * The file sits in `<userData>/logs/main.log` and is never sent anywhere. It
 * rotates by size: when the next line would push it past `maxBytes`, it
 * becomes `main.old.log` (replacing the one before) and a fresh file starts,
 * so the two together never hold much more than twice `maxBytes`.
 *
 * Writes are synchronous on purpose: the lines that matter most are written
 * from an `uncaughtException` handler, where an asynchronous write may never
 * land. Main writes warnings and errors only — a handful per start — so the
 * cost does not show.
 *
 * Nothing here throws. A log that cannot be written must not become the next
 * uncaught error; after a failed write the file is left alone for this start.
 */

const util = require('util');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const FILE_NAME = 'main.log';
const OLD_FILE_NAME = 'main.old.log';

/**
 * `util.format` gives an Error its stack and an object its shape, as `console` does.
 *
 * @param {unknown[]} args
 */
function formatArgs(args) {
  try {
    return util.format(...args);
  } catch {
    return args.map((arg) => String(arg)).join(' ');
  }
}

/**
 * One line per entry: continuation lines of a stack are indented under it.
 *
 * @param {string} time
 * @param {string} level
 * @param {unknown} text
 */
function formatLine(time, level, text) {
  const body = String(text).replace(/\r\n?/g, '\n').replace(/\n/g, '\n    ');
  return `${time} ${level.toUpperCase().padEnd(5)} ${body}\n`;
}

/**
 * @param {{ fs: typeof import('fs'), path: typeof import('path'), dir: string,
 *   maxBytes?: number, now?: () => Date }} options
 */
function createLogFile({ fs, path, dir, maxBytes = DEFAULT_MAX_BYTES, now = () => new Date() }) {
  const filePath = path.join(dir, FILE_NAME);
  const oldFilePath = path.join(dir, OLD_FILE_NAME);
  /** @type {number|null} */
  let size = null;
  let broken = false;

  function currentSize() {
    if (size !== null) return size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      size = 0;
    }
    return size;
  }

  function rotate() {
    try {
      fs.renameSync(filePath, oldFilePath);
    } catch {
      // Nothing to rotate yet, or the old file is held open: start afresh anyway.
    }
    size = 0;
  }

  /**
   * Appends one entry; `level` is `info`, `warn` or `error`.
   *
   * @param {string} level
   * @param {unknown[]} args
   */
  function write(level, ...args) {
    if (broken) return;
    const line = formatLine(now().toISOString(), level, formatArgs(args));
    const bytes = Buffer.byteLength(line);
    try {
      if (size === null) fs.mkdirSync(dir, { recursive: true });
      if (currentSize() > 0 && currentSize() + bytes > maxBytes) rotate();
      fs.appendFileSync(filePath, line);
      size = currentSize() + bytes;
    } catch {
      broken = true;
    }
  }

  /** The last `count` lines across both files, oldest first — for the diagnostics. */
  /** @param {number} count */
  function tail(count) {
    /** @type {string[]} */
    const lines = [];
    for (const file of [oldFilePath, filePath]) {
      try {
        lines.push(...fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== ''));
      } catch {
        // A file that is not there has no lines.
      }
    }
    return lines.slice(-count);
  }

  return { filePath, dir, write, tail };
}

/**
 * Lets `console.warn` and `console.error` write to the log as well, and still
 * to the terminal as before. Every place in main that logs — directly or
 * through an injected `log = console` — reaches the file without a change,
 * and so do the renderer's errors that renderer-console.js forwards.
 * Returns the function that puts `console` back.
 *
 * @param {{ warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} target  `console`, or a stand-in for it
 * @param {{ write: (level: string, ...args: unknown[]) => void }} logFile
 */
function teeConsole(target, logFile) {
  const originals = { warn: target.warn, error: target.error };
  for (const level of /** @type {const} */ (['warn', 'error'])) {
    const original = originals[level];
    target[level] = (...args) => {
      logFile.write(level, ...args);
      try {
        original.apply(target, args);
      } catch {
        // A closed stdout (EPIPE) must not turn a log line into an uncaught error.
      }
    };
  }
  return () => Object.assign(target, originals);
}

module.exports = { createLogFile, teeConsole, formatLine, DEFAULT_MAX_BYTES };
