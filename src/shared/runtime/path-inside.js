'use strict';

/**
 * Whether `candidate` lies inside `root`, the root itself included (#555).
 *
 * `path.relative` answers `..` or `../…` for a path outside the root. A test
 * for `startsWith('..')` also takes a name inside that merely begins with two
 * dots (`..cache`) for one outside — open where it guards a protected folder,
 * closed where it admits a selection. Only `..` as a whole segment is outside.
 *
 * @param {typeof import('path')} pathMod  `path`, or `path.win32` / `path.posix` in tests
 * @param {string} root
 * @param {string} candidate
 */
function isPathInside(pathMod, root, candidate) {
  const rel = pathMod.relative(root, candidate);
  if (rel === '') return true;
  if (pathMod.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${pathMod.sep}`);
}

module.exports = { isPathInside };
