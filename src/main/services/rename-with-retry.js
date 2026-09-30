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
 * `readFileWithRetry` retries under the same rules.
 */

const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function withTransientRetry(operation, {
  platform = process.platform,
  attempts = 8,
  delayMs = 25,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

function renameWithRetry(fs, from, to, options) {
  return withTransientRetry(() => fs.rename(from, to), options);
}

function readFileWithRetry(fs, file, options) {
  return withTransientRetry(() => fs.readFile(file, 'utf8'), options);
}

module.exports = { renameWithRetry, readFileWithRetry, RETRYABLE_CODES };
