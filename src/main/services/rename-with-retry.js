'use strict';

/**
 * `fs.rename` that survives Windows' transient locks.
 *
 * Replacing a file on Windows fails with EPERM, EACCES or EBUSY while another
 * handle has it open — a reader in this process, the indexer, an antivirus
 * scanner looking at the fresh temporary file. The lock is gone a moment
 * later, so a short retry is the known remedy (graceful-fs does the same).
 * Elsewhere, and for any other error, the first failure is the answer.
 */

const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function renameWithRetry(fs, from, to, {
  platform = process.platform,
  attempts = 8,
  delayMs = 25,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.rename(from, to);
    } catch (error) {
      const retryable = platform === 'win32' && RETRYABLE_CODES.has(error?.code);
      if (!retryable || attempt >= attempts) throw error;
      await sleep(delayMs * attempt);
    }
  }
}

module.exports = { renameWithRetry, RETRYABLE_CODES };
