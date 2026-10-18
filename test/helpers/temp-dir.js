'use strict';

/**
 * Removing the folders tests create (#1132).
 *
 * On Windows a recursive `rm` fails with `ENOTEMPTY`, `EBUSY` or `EPERM` while
 * a handle inside the folder is still closing — a write that is settling, or
 * Defender scanning a file that was just written. Node retries those codes,
 * with a linear back-off, only when `maxRetries` is set. Every recursive `rm`
 * in `test/` and `e2e/` therefore goes through here; `temp-dir.test.js` keeps
 * it that way.
 *
 * - `removeTempDir` / `removeTempDirSync` clean up after a test. A folder that
 *   still cannot be removed is left behind in the temp directory with a
 *   warning: the cleanup is not what the test checks.
 * - `removeDir` removes a folder as a step of the test. It retries the same
 *   way but throws when that does not help, because the steps after it rely
 *   on the folder being gone.
 */

const fs = require('node:fs');

const RM_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

function leftBehind(dir, err) {
  console.warn(`temp-dir: left ${dir} behind (${err.code || err.message})`);
}

/** @param {string} dir */
async function removeTempDir(dir) {
  try {
    await fs.promises.rm(dir, RM_OPTIONS);
  } catch (err) {
    leftBehind(dir, err);
  }
}

/** @param {string} dir */
function removeTempDirSync(dir) {
  try {
    fs.rmSync(dir, RM_OPTIONS);
  } catch (err) {
    leftBehind(dir, err);
  }
}

/** @param {string} dir */
function removeDir(dir) {
  return fs.promises.rm(dir, RM_OPTIONS);
}

module.exports = { removeTempDir, removeTempDirSync, removeDir };
