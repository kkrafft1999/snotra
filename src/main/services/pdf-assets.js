'use strict';

/**
 * The data files pdf.js asks for while it renders a PDF (#346): CMaps,
 * standard fonts, image decoders. They ship with the app under
 * `src/renderer/vendor/pdfjs/`, copied there by `scripts/sync-renderer-vendor.js`.
 *
 * The renderer could load them itself only with `connect-src` opened for
 * `file:` — which would let it read any file on the disk, the very thing the
 * CSP keeps it from. So it asks here, by kind and file name, and gets bytes
 * from one of three fixed folders or nothing.
 */

const { PDF_ASSET_DIRS, isPdfAssetName } = require('../../shared/contracts/workspace-pdf');

/** @type {Readonly<Record<string, string>>} */
const ASSET_DIRS = PDF_ASSET_DIRS;

/**
 * @param {object} deps
 * @param {Pick<typeof import('fs/promises'), 'readFile'>} deps.fs
 * @param {Pick<typeof import('path'), 'resolve' | 'join' | 'dirname'>} deps.path
 * @param {string} deps.rootDir
 */
function createPdfAssetReader({ fs, path, rootDir }) {
  const root = path.resolve(rootDir);

  /**
   * `{ ok: true, bytes }` or `{ ok: false }` — pdf.js only needs to know it failed.
   *
   * @param {string} kind
   * @param {string} filename
   */
  async function readPdfAsset(kind, filename) {
    const dir = Object.hasOwn(ASSET_DIRS, kind) ? ASSET_DIRS[kind] : null;
    if (!dir || !isPdfAssetName(filename)) return { ok: false };
    const folder = path.join(root, dir);
    const target = path.join(folder, filename);
    // The name check already rules out separators; this is the second lock.
    if (path.dirname(target) !== folder) return { ok: false };
    try {
      return { ok: true, bytes: await fs.readFile(target) };
    } catch {
      return { ok: false };
    }
  }

  return { readPdfAsset };
}

module.exports = { createPdfAssetReader };
