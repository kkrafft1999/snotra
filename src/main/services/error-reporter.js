'use strict';

const { NOTICE_KINDS, BACKGROUND_ERROR_NOTICE_ID } = require('../../shared/contracts/notices');

/**
 * The one path for errors nobody caught (#978): in main, an exception that
 * ran out of a callback or a promise rejected with nobody waiting; in the
 * window, the same reported over IPC. A chat run has a catch-all of its own
 * and never comes here.
 *
 * Each error goes to the log with its stack and counts towards one notice in
 * the window — "something went wrong in the background", with the count and
 * the log file. One notice for all of them, not one per error: an error
 * thrown in a loop would otherwise flood the strip. Posting it again shows it
 * again after the user closed it, which is right for a new error, but not
 * fifty times a second — so after the first post, further ones wait and go
 * out as one. The wait starts at `coalesceMs` and doubles with every post, up
 * to `maxCoalesceMs`: an error that keeps coming back cannot pull a closed
 * notice back up every second.
 *
 * The details of the first `maxLogged` errors are logged; after that only the
 * count goes up, so an error in a loop cannot rotate the earlier ones out of
 * the log.
 */
const DEFAULT_COALESCE_MS = 1000;
const DEFAULT_MAX_COALESCE_MS = 60_000;
const DEFAULT_MAX_LOGGED = 100;

const RENDERER_TEXT_MAX = 4000;

/**
 * @param {string} text
 * @param {number} max
 */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * What the window reports, checked: it comes over IPC and is only ever
 * written to the log, but a broken payload must not throw here either.
 * `null` when it carries nothing to report.
 *
 * @param {{ source?: unknown, message?: unknown, stack?: unknown, at?: unknown }|null|undefined} input
 */
function normalizeRendererReport(input) {
  if (!input || typeof input !== 'object') return null;
  const source = input.source === 'rejection' ? 'rejection' : 'error';
  const message = typeof input.message === 'string' ? truncate(input.message, RENDERER_TEXT_MAX) : '';
  const stack = typeof input.stack === 'string' ? truncate(input.stack, RENDERER_TEXT_MAX) : '';
  const at = typeof input.at === 'string' ? truncate(input.at, 500) : '';
  if (!message && !stack) return null;
  return { source, message, stack, at };
}

/**
 * @param {{ log?: { error?: (...args: unknown[]) => void }|null,
 *   notices?: Pick<ReturnType<typeof import('./app-notices').createAppNotices>, 'post'> | null,
 *   logFilePath?: string | null, coalesceMs?: number, maxCoalesceMs?: number, maxLogged?: number,
 *   now?: () => number, setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown } }} [options]
 */
function createErrorReporter({
  log = console,
  notices = null,
  logFilePath = null,
  coalesceMs = DEFAULT_COALESCE_MS,
  maxCoalesceMs = DEFAULT_MAX_COALESCE_MS,
  maxLogged = DEFAULT_MAX_LOGGED,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  let count = 0;
  let lastPostAt = -Infinity;
  let wait = coalesceMs;
  /** @type {{ unref?: () => unknown }|null} */
  let timer = null;

  function post() {
    if (lastPostAt > -Infinity) wait = Math.min(wait * 2, maxCoalesceMs);
    timer = null;
    lastPostAt = now();
    try {
      notices?.post({ id: BACKGROUND_ERROR_NOTICE_ID, kind: NOTICE_KINDS.BACKGROUND_ERROR, count, location: logFilePath });
    } catch {
      // The notice is the second channel; the log already has the error.
    }
  }

  function schedulePost() {
    if (timer) return;
    const remaining = lastPostAt + wait - now();
    if (remaining <= 0) {
      post();
      return;
    }
    timer = setTimer(post, remaining);
    timer?.unref?.();
  }

  /** @param {unknown[]} args */
  function writeLog(...args) {
    try {
      log?.error?.(...args);
    } catch {
      // Logging an error must not become the next one.
    }
  }

  /**
   * `label` says what kind of error it was; `error` is whatever was thrown.
   *
   * @param {string} source
   * @param {string} label
   * @param {unknown} error
   */
  function report(source, label, error) {
    count += 1;
    if (count <= maxLogged) {
      writeLog(`[${source}] ${label}:`, error);
    } else if (count === maxLogged + 1) {
      writeLog(`[errors] More than ${maxLogged} errors in this start; further ones are counted, not logged.`);
    }
    schedulePost();
  }

  /**
   * An error the window caught with its global handlers.
   *
   * @param {Parameters<typeof normalizeRendererReport>[0]} input
   */
  function reportRenderer(input) {
    const entry = normalizeRendererReport(input);
    if (!entry) return false;
    const label = entry.source === 'rejection' ? 'Unhandled promise rejection' : 'Uncaught error';
    const where = entry.at ? ` (${entry.at})` : '';
    // The stack starts with the message as a rule; then it says it all.
    const detail = entry.stack && entry.stack.includes(entry.message) ? entry.stack : [entry.message, entry.stack].filter(Boolean).join('\n');
    report('renderer', label, `${detail}${where}`);
    return true;
  }

  return { report, reportRenderer, count: () => count };
}

/**
 * Main's process-level handlers. Without them Electron shows its own box with
 * a raw stack and the error leaves no trace; with them it is logged and
 * counted, and the app goes on — as it did after Electron's box.
 * Returns the function that removes them again.
 *
 * @param {Pick<NodeJS.Process, 'on' | 'removeListener'>} proc
 * @param {Pick<ReturnType<typeof createErrorReporter>, 'report'>} reporter
 */
function installProcessErrorHandlers(proc, reporter) {
  /** @param {unknown} error */
  const onException = (error) => reporter.report('main', 'Uncaught exception', error);
  /** @param {unknown} reason */
  const onRejection = (reason) => reporter.report('main', 'Unhandled promise rejection', reason);
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.removeListener('uncaughtException', onException);
    proc.removeListener('unhandledRejection', onRejection);
  };
}

module.exports = {
  createErrorReporter,
  installProcessErrorHandlers,
  normalizeRendererReport,
  DEFAULT_COALESCE_MS,
  DEFAULT_MAX_COALESCE_MS,
  DEFAULT_MAX_LOGGED,
};
