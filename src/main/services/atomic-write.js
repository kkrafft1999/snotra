'use strict';

/**
 * Replaces a file so that a crash or a power cut never leaves half of it
 * behind (#1013).
 *
 * The content goes into a fresh temporary file next to the target, is flushed
 * to the disk (`fsync`) and only then renamed over the target. A rename alone
 * is not enough: without the flush the file system may persist the rename
 * before the data, and after a power cut the target is there but empty. The
 * temporary file is created exclusively, so two writers never share one, and
 * it is removed again when anything fails. The rename retries Windows'
 * transient locks like every other writer here (#419, #472).
 *
 * `fs` is the promises API, injected so that tests can wrap it.
 */

const { randomUUID } = require('crypto');
const { renameWithRetry } = require('./rename-with-retry');

/** The part of `fs/promises` that is used, so a test can hand in a wrapper of it. */
/** @typedef {Pick<typeof import('fs/promises'), 'open' | 'unlink' | 'rename'>} AtomicWriteFs */

/**
 * @param {AtomicWriteFs} fs          `fs/promises` or a wrapper of it.
 * @param {string} targetPath         The file to replace.
 * @param {string|Buffer} data        Its new content.
 * @param {object} [options]
 * @param {number} [options.mode]     File mode of a newly created file.
 * @param {BufferEncoding} [options.encoding] For string data; `utf8` by default.
 * @param {string} [options.platform] For the rename retry; the running one by default.
 */
async function writeFileAtomic(fs, targetPath, data, { mode, encoding = 'utf8', platform } = {}) {
  const tmp = `${targetPath}.tmp-${randomUUID()}`;
  try {
    const handle = await fs.open(tmp, 'wx', mode);
    try {
      await handle.writeFile(data, typeof data === 'string' ? encoding : undefined);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(fs, tmp, targetPath, platform ? { platform } : undefined);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

module.exports = { writeFileAtomic };
