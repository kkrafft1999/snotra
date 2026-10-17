/**
 * The window's global error handlers (#978). An exception that ran out of an
 * event handler, or a promise rejected with nobody waiting, is handed to main,
 * which logs it with its stack and counts it towards the background-error
 * notice. The tool-log buffer (#919) keeps its own record for the chat's
 * diagnostics; this is the path that reaches the user.
 *
 * Kept free of the DOM beyond `addEventListener`, so it can be tested with a
 * plain event target.
 */

const TEXT_MAX = 4000;

/**
 * Chromium raises these as window errors although nothing failed: the
 * ResizeObserver note means one frame's notifications slipped to the next.
 * Counting them would put a warning in front of the user for nothing.
 */
const BENIGN_MESSAGES = [
  /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/,
];

/** After this many reports in one page the rest is not sent — a loop would only repeat itself. */
const DEFAULT_MAX_REPORTS = 500;

function truncate(text) {
  return text.length <= TEXT_MAX ? text : `${text.slice(0, TEXT_MAX - 1)}…`;
}

function messageOf(value, fallback) {
  if (value instanceof Error || (value && typeof value.message === 'string')) return value.message;
  if (value === undefined || value === null) return fallback;
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

/** `{ source, message, stack, at }` for an `error` or `unhandledrejection` event; null for a benign one. */
export function describeUncaughtEvent(event) {
  const isRejection = event?.type === 'unhandledrejection';
  const value = isRejection ? event?.reason : event?.error;
  const message = truncate(messageOf(value, isRejection ? 'unknown reason' : (event?.message || 'unknown error')) || '');
  if (BENIGN_MESSAGES.some((pattern) => pattern.test(message))) return null;
  const stack = typeof value?.stack === 'string' ? truncate(value.stack) : '';
  const at = !isRejection && event?.filename ? `${event.filename}:${event.lineno ?? 0}` : '';
  return { source: isRejection ? 'rejection' : 'error', message, stack, at };
}

/**
 * Listens on `target` (the window) and hands each error to `report`.
 * Returns the function that stops listening.
 */
export function reportUncaughtErrors(target, report, { maxReports = DEFAULT_MAX_REPORTS } = {}) {
  if (!target || typeof target.addEventListener !== 'function' || typeof report !== 'function') return () => {};
  let sent = 0;
  const onEvent = (event) => {
    if (sent >= maxReports) return;
    const entry = describeUncaughtEvent(event);
    if (!entry) return;
    sent += 1;
    try {
      // Reporting must not throw from inside an error handler.
      void Promise.resolve(report(entry)).catch(() => {});
    } catch {
      // Same: nothing to do but go on.
    }
  };
  target.addEventListener('error', onEvent);
  target.addEventListener('unhandledrejection', onEvent);
  return () => {
    target.removeEventListener('error', onEvent);
    target.removeEventListener('unhandledrejection', onEvent);
  };
}
