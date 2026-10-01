'use strict';

/**
 * Reading and writing the text files Snotra embeds into the system prompt
 * without being asked: `AGENTS.md` and both `memory.md` (#534).
 *
 * A plain `readFile` follows a symlink wherever it leads. The folder's two
 * files come with the opened folder, so a cloned repository could ship
 * `AGENTS.md -> ../../.aws/credentials` and have that file sent along with
 * every message, or `.agents/memory.md -> ~/.gitconfig` and have `remember`
 * append to it. Neither passes the §4 path check, which only the file tools
 * run. So here:
 *
 * - **Contained.** With a `root`, a file counts only when its real path is a
 *   regular file inside the real root; a symlink that stays inside keeps
 *   working, one that leads out is treated as absent on read and refused on
 *   write. Without a `root` — the global files in the home folder, which a
 *   dotfiles manager typically links elsewhere — the target only has to be a
 *   regular file.
 * - **Bounded.** A read for the prompt stops at its limit instead of reading
 *   the whole file and cutting it afterwards; a device or a pipe is not a
 *   regular file and is never opened.
 * - **Atomic.** A write goes to a temporary file next to the real target and
 *   is renamed onto it, so a crash leaves the old file or the new one, never
 *   half of it, and a symlink inside the root is written through, not
 *   replaced.
 */

const { randomUUID } = require('crypto');
const { isPathInside } = require('../../shared/runtime/path-inside');
const { renameWithRetry, readFileWithRetry } = require('./rename-with-retry');

/** Above this a file is not edited in place — it is far beyond any limit here. */
const MAX_UPDATE_BYTES = 1024 * 1024;

/** The refusal when a file or its folder leads out of its root. */
class EmbeddedFileOutsideRootError extends Error {
  constructor(file) {
    super(`"${file}" leads outside the open folder (symlink); nothing was read or written.`);
    this.name = 'EmbeddedFileOutsideRootError';
    this.code = 'EOUTSIDEROOT';
  }
}

function notRegularFile(file) {
  const error = new Error(`"${file}" is not a regular file; nothing was written.`);
  error.code = 'ENOTREGULAR';
  return error;
}

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {string} [deps.platform]
 */
function createEmbeddedTextFiles({ fs, path, platform = process.platform }) {
  if (!fs || !path) throw new TypeError('createEmbeddedTextFiles needs fs and path.');

  async function realRootOf(root) {
    return root ? fs.realpath(root) : null;
  }

  function inside(realRoot, realTarget) {
    return !realRoot || isPathInside(path, realRoot, realTarget);
  }

  /**
   * The real path of an existing file, checked against the root, or null when
   * there is no file. Throws when the file leads out or is not a regular one.
   */
  async function resolveExisting(file, root) {
    let real;
    try {
      real = await fs.realpath(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!inside(await realRootOf(root), real)) throw new EmbeddedFileOutsideRootError(file);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw notRegularFile(file);
    return { real, stat };
  }

  /**
   * Read for the prompt: the text up to `maxChars`, or null for anything that
   * is not a usable file — missing, unreadable, outside the root, not regular.
   * None of these is an error; an instruction file that is not there is the
   * normal case.
   *
   * @returns {Promise<{ text: string, truncated: boolean } | null>}
   */
  async function readForPrompt({ file, root = null, maxChars }) {
    let resolved;
    try {
      resolved = await resolveExisting(file, root);
    } catch {
      return null;
    }
    if (!resolved) return null;
    // A character takes at most four bytes in UTF-8 and at least one UTF-16
    // unit, so this many bytes always yield more than `maxChars` characters
    // when the file has them — and a sequence cut at the end lies beyond them.
    const limit = maxChars * 4 + 4;
    let handle;
    try {
      handle = await fs.open(resolved.real, 'r');
      const buffer = Buffer.alloc(Math.min(limit, Math.max(0, resolved.stat.size) || limit));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const raw = buffer.subarray(0, length).toString('utf8');
      const truncated = raw.length > maxChars || resolved.stat.size > length;
      return { text: truncated ? raw.slice(0, maxChars) : raw, truncated };
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /**
   * Read a file that is about to be written back. Only a missing file means
   * "start empty" (null). Anything else is thrown, so the caller writes
   * nothing and the file stays as it is — a read that failed for a moment
   * must not end as a file holding nothing but the new entry (#473).
   *
   * @returns {Promise<string | null>}
   */
  async function readForUpdate({ file, root = null }) {
    const resolved = await resolveExisting(file, root);
    if (!resolved) return null;
    if (resolved.stat.size > MAX_UPDATE_BYTES) {
      throw new RangeError(`"${file}" is too large to be changed here.`);
    }
    return readFileWithRetry(fs, resolved.real, { platform });
  }

  /**
   * The nearest existing folder above `dir`, as a real path — what a `mkdir`
   * of `dir` would build on.
   */
  async function nearestExistingRealDir(dir) {
    for (let current = dir; ; current = path.dirname(current)) {
      try {
        return await fs.realpath(current);
      } catch (error) {
        if (!error || error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      }
    }
  }

  /** Replace the file's text atomically, refusing a target outside the root. */
  async function write({ file, root = null, text }) {
    const realRoot = await realRootOf(root);
    const existing = await resolveExisting(file, root);
    let target;
    if (existing) {
      target = existing.real;
    } else {
      // Checked before anything is created: `mkdir` on a path through a
      // symlinked `.agents/` would build the folders outside.
      const dir = path.dirname(file);
      if (!inside(realRoot, await nearestExistingRealDir(dir))) {
        throw new EmbeddedFileOutsideRootError(file);
      }
      await fs.mkdir(dir, { recursive: true });
      const realDir = await fs.realpath(dir);
      if (!inside(realRoot, realDir)) throw new EmbeddedFileOutsideRootError(file);
      target = path.join(realDir, path.basename(file));
    }
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
    const options = existing ? { encoding: 'utf8', mode: existing.stat.mode & 0o777 } : 'utf8';
    await fs.writeFile(tmp, text, options);
    try {
      await renameWithRetry(fs, tmp, target, { platform });
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
    return target;
  }

  return { readForPrompt, readForUpdate, write };
}

module.exports = {
  createEmbeddedTextFiles,
  EmbeddedFileOutsideRootError,
  MAX_UPDATE_BYTES,
};
