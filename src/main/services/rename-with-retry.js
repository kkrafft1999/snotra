'use strict';

/**
 * `fs.rename` that survives Windows' transient locks.
 *
 * Replacing a file on Windows fails with EPERM, EACCES or EBUSY while another
 * handle has it open — a reader in this process, the indexer, an antivirus
 * scanner looking at the fresh temporary file. The lock is gone a moment
 * later, so a short retry is the known remedy (graceful-fs does the same).
 * Elsewhere, and for any other error, the first failure is the answer.
 *
 * Reading has the same trap (#473): a file that is about to be written back
 * must not be taken for missing just because a scanner held it for a moment.
 * `readFileWithRetry` retries under the same rules, and so does
 * `unlinkWithRetry` for a chat's file that is deleted (#985).
 *
 * The window state is written synchronously on `close` — the process may be
 * gone right after — so it gets `renameSyncWithRetry`, which blocks between
 * the attempts instead of awaiting (#509). Worst case about 0.7 s, and only
 * on Windows with a locked file.
 */

/**
 * @typedef {{ platform?: string, attempts?: number, delayMs?: number }} RetryTiming
 * @typedef {RetryTiming & { sleep?: (ms: number) => Promise<void> }} RetryOptions
 * @typedef {RetryTiming & { sleep?: (ms: number) => void }} RetrySyncOptions
 */

const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * @template T
 * @param {() => Promise<T>} operation
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
async function withTransientRetry(operation, {
  platform = process.platform,
  attempts = 8,
  delayMs = 25,
  sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = platform === 'win32' && RETRYABLE_CODES.has(error?.code);
      if (!retryable || attempt >= attempts) throw error;
      await sleep(delayMs * attempt);
    }
  }
}

/**
 * Blocks the thread for `ms` without spinning.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @template T
 * @param {() => T} operation
 * @param {RetrySyncOptions} [options]
 * @returns {T}
 */
function withTransientRetrySync(operation, {
  platform = process.platform,
  attempts = 8,
  delayMs = 25,
  sleep = sleepSync,
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      const retryable = platform === 'win32' && RETRYABLE_CODES.has(error?.code);
      if (!retryable || attempt >= attempts) throw error;
      sleep(delayMs * attempt);
    }
  }
}

/**
 * @param {{ renameSync(from: string, to: string): void }} fs
 * @param {string} from
 * @param {string} to
 * @param {RetrySyncOptions} [options]
 */
function renameSyncWithRetry(fs, from, to, options) {
  return withTransientRetrySync(() => fs.renameSync(from, to), options);
}

/**
 * @param {{ rename(from: string, to: string): Promise<unknown> }} fs
 * @param {string} from
 * @param {string} to
 * @param {RetryOptions} [options]
 */
function renameWithRetry(fs, from, to, options) {
  return withTransientRetry(() => fs.rename(from, to), options);
}

/**
 * @param {{ readFile(file: string, encoding: 'utf8'): Promise<string> }} fs
 * @param {string} file
 * @param {RetryOptions} [options]
 */
function readFileWithRetry(fs, file, options) {
  return withTransientRetry(() => fs.readFile(file, 'utf8'), options);
}

/**
 * @param {{ unlink(file: string): Promise<unknown> }} fs
 * @param {string} file
 * @param {RetryOptions} [options]
 */
function unlinkWithRetry(fs, file, options) {
  return withTransientRetry(() => fs.unlink(file), options);
}

module.exports = { renameWithRetry, renameSyncWithRetry, readFileWithRetry, unlinkWithRetry, RETRYABLE_CODES };
