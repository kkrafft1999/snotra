'use strict';

// The file system as it is on disk, without Electron's asar layer.
//
// Inside Electron, `fs` treats an `.asar` file as a folder: it will not hand
// out the archive's raw bytes, and a recursive `rm` descends into the archive
// instead of unlinking it — the file stays, and on macOS the call never even
// settles (#914). Every package of this app carries `resources/app.asar`, so
// whatever reads a package or removes one goes through `original-fs`, the
// unpatched module. Outside Electron (the tests) there is no such module, and
// plain `fs` does the same job.

const fs = require('fs');

/** @type {typeof fs} */
const rawFs = (() => {
  // A variable specifier on purpose: `original-fs` exists only inside
  // Electron, and the type-check configuration does not load its typings.
  const electronFs = 'original-fs';
  try { return require(electronFs); } catch { return fs; }
})();

/**
 * Removes a folder and everything in it, archives included. A folder that is
 * not there is not an error.
 *
 * @param {string} dir
 */
function removeTree(dir) {
  return rawFs.promises.rm(dir, { recursive: true, force: true });
}

module.exports = { rawFs, removeTree };
