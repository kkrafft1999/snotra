'use strict';

/**
 * A watch that fails — the kernel out of watches, the folder cap reached, a
 * folder that cannot be watched — is said in the log, naming the folder
 * (#648). A folder that keeps failing must not flood it, though: one line per
 * watcher and minute, with a count of what was held back since.
 */

const WATCHER_WARNING_INTERVAL_MS = 60_000;

/**
 * @param {string} label  the watcher's name, in brackets at the start of the line
 * @param {Object} [options]
 * @param {{ warn: Function }} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.intervalMs]
 * @returns {(error: Error|null|undefined, dir: string) => void}  the watcher's `onError`
 */
function createWatcherWarning(label, { log = console, now = Date.now, intervalMs = WATCHER_WARNING_INTERVAL_MS } = {}) {
  let lastWarnedAt = -Infinity;
  let heldBack = 0;
  return (error, dir) => {
    const at = now();
    if (at - lastWarnedAt < intervalMs) {
      heldBack += 1;
      return;
    }
    lastWarnedAt = at;
    const more = heldBack > 0 ? ` (${heldBack} more since the last warning)` : '';
    heldBack = 0;
    const reason = [error?.code, error?.message].filter(Boolean).join(' ');
    log.warn(`[${label}] cannot watch ${dir}: ${reason}${more}`);
  };
}

module.exports = {
  createWatcherWarning,
  WATCHER_WARNING_INTERVAL_MS,
};
