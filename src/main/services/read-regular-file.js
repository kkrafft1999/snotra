'use strict';

const { constants: fsConstants } = require('fs');

/**
 * Reads a regular file, and only a regular file (#643).
 *
 * "`stat`, then `readFile`" opens whatever the path names. A FIFO reports a
 * size of 0 and is no folder, so `readFile` opens it — and `open(2)` on a FIFO
 * blocks a thread-pool thread until a writer appears. Four of them stall every
 * file operation of the main process. So the file is opened non-blocking, the
 * *handle* is checked, and at most `maxBytes + 1` bytes are read from that
 * same handle: what was checked is what is read, even when the path is swapped
 * in between.
 *
 * Resolves to one of
 * - `{ buffer, stats }` — the content;
 * - `{ notFile: true, stats }` — a folder, pipe, socket or device;
 * - `{ tooLarge: true, stats }` — more than `maxBytes`, checked before and
 *   while reading, so a file that grows is not read to its end.
 *
 * Any other error of `open` (`ENOENT`, `EACCES`, …) is thrown.
 *
 * @param {typeof import('fs/promises')} fs
 * @param {string} absPath
 * @param {{ maxBytes?: number }} [options]
 */
async function readRegularFile(fs, absPath, { maxBytes = Infinity } = {}) {
  let handle;
  try {
    handle = await fs.open(absPath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0));
  } catch (err) {
    // A socket cannot be opened at all (ENXIO on Linux, an unnamed -102 on
    // macOS), and Windows refuses a folder with EISDIR. Whatever the code: if
    // the path exists and is not a regular file, that is the answer.
    if (err && err.code !== 'ENOENT') {
      const stats = await fs.stat(absPath).catch(() => null);
      if (stats && !stats.isFile()) return { notFile: true, stats };
    }
    throw err;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { notFile: true, stats };
    if (stats.size > maxBytes) return { tooLarge: true, stats };
    const chunkSize = Math.min(Math.max(stats.size + 1, 16 * 1024), 1024 * 1024);
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunkSize ? chunk : chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) return { tooLarge: true, stats };
    }
    return { buffer: Buffer.concat(chunks, total), stats };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The error text the model's tools give for a pipe, socket or device. */
const NOT_A_REGULAR_FILE_ERROR = 'Not a regular file (a pipe, socket or device). Only regular files can be read.';

module.exports = { readRegularFile, NOT_A_REGULAR_FILE_ERROR };
