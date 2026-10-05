'use strict';

const os = require('os');
const path = require('path');

/**
 * `shell.trashItem` with a way out on macOS (#712).
 *
 * A Developer-ID-signed app — Snotra since 1.13.5 — is refused by
 * `NSFileManager trashItemAtURL:` for files in a SharePoint library that
 * OneDrive syncs into `~/Library/CloudStorage`: "… could not be moved to the
 * trash because you don't have permission". The same call from an ad hoc
 * signed Electron succeeds, and so does Finder; the signed app may still
 * `rename` the file. So when the trash API refuses on macOS and the item is
 * still there, it is moved into `~/.Trash` directly. It stays recoverable from
 * the trash; only Finder's "Put Back" does not know where it came from.
 *
 * Only `rename`, never copy and delete: an item on another volume (EXDEV) or a
 * home without `~/.Trash` keeps the original error, which says more than ours
 * would. An entry already in the trash is never replaced — the name is chosen
 * the way Finder does it (`name.ext`, `name 08.45.12.ext`, `name 08.45.12 2.ext`,
 * …). Between the check and the rename another program could still put an
 * entry there; only Finder writes into the trash, so that window is accepted.
 * `~/.Trash` itself cannot be listed without Full Disk Access, but a single
 * name in it can be looked up, which is all this needs.
 *
 * Windows and Linux keep the trash API's answer as it is.
 */

const MAX_NAME_ATTEMPTS = 100;

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

/**
 * The name for `attempt` (0, 1, 2, …): unchanged first, then with the time of
 * day, then counted as well. A folder has no extension, so `v1.2` stays whole.
 */
function trashName(baseName, { isDirectory = false, date, attempt }) {
  if (attempt === 0) return baseName;
  const ext = isDirectory ? '' : path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(twoDigits).join('.');
  const counter = attempt > 1 ? ` ${attempt}` : '';
  return `${stem} ${time}${counter}${ext}`;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * @param {object} options
 * @param {(target: string) => Promise<void>} options.trashItem  `shell.trashItem`
 * @returns {(target: string) => Promise<void>} resolves once the item is in
 *   the trash, rejects with the trash API's error otherwise
 */
function createMoveToTrash({
  trashItem,
  platform = process.platform,
  fs = require('fs').promises,
  homedir = os.homedir,
  now = () => new Date(),
  logger = console,
}) {
  if (typeof trashItem !== 'function') throw new TypeError('trashItem must be a function');

  /** Whether a name in the trash is taken. Unknown counts as taken. */
  async function isTaken(candidate) {
    try {
      await fs.lstat(candidate);
      return true;
    } catch (error) {
      return error?.code !== 'ENOENT';
    }
  }

  /** True once the item is in `~/.Trash`, false when this way is closed too. */
  async function renameIntoTrash(target, refusal) {
    const trashDir = path.join(homedir(), '.Trash');
    const source = path.resolve(target);
    if (isInside(trashDir, source)) return false;

    let stats;
    try {
      stats = await fs.lstat(source);
      if (!(await fs.stat(trashDir)).isDirectory()) return false;
    } catch {
      return false;
    }

    const date = now();
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const name = trashName(path.basename(source), { isDirectory: stats.isDirectory(), date, attempt });
      const destination = path.join(trashDir, name);
      if (await isTaken(destination)) continue;
      try {
        await fs.rename(source, destination);
      } catch (error) {
        logger.warn('[move-to-trash] Moving into ~/.Trash failed as well:', error?.message ?? error);
        return false;
      }
      logger.warn('[move-to-trash] The trash refused, moved into ~/.Trash instead:', refusal?.message ?? refusal);
      return true;
    }
    return false;
  }

  return async function moveToTrash(target) {
    try {
      await trashItem(target);
    } catch (error) {
      if (platform !== 'darwin' || !(await renameIntoTrash(target, error))) throw error;
    }
  };
}

module.exports = { createMoveToTrash, trashName };
