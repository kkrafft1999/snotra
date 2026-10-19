'use strict';

/**
 * Outside the open folder (#792, step 4): what the file tools may use there,
 * once a card opened it. Which grants a card may offer at all is
 * `src/main/services/outside-access.js`, which knows the home folder and
 * Snotra's own storage; this is the part the planner needs (#982).
 */

/** What resolving a tool path reports for a path outside the open folder: a card may offer it. */
const OUTSIDE_WORKSPACE = 'outside_workspace';

/**
 * The roots the file tools may use outside the open folder, from grants:
 * a folder grant is its folder, a file grant the file's folder with that one
 * name. Malformed entries are dropped.
 *
 * @returns {Array<{ root: string, only: string|null, access: 'read'|'write' }>}
 * @param {unknown} grants
 * @param {typeof import('path')} path
 */
function outsideRootsFrom(grants, path) {
  /** @type {Array<{ root: string, only: string|null, access: 'read'|'write' }>} */
  const out = [];
  /** @type {Array<{ path?: unknown, file?: unknown, access?: unknown } | null | undefined>} */
  const list = Array.isArray(grants) ? grants : [];
  for (const grant of list) {
    if (!grant || typeof grant.path !== 'string' || !path.isAbsolute(grant.path)) continue;
    const p = path.resolve(grant.path);
    /** @type {'read'|'write'} */
    const access = grant.access === 'write' ? 'write' : 'read';
    out.push(grant.file === true
      ? { root: path.dirname(p), only: path.basename(p), access }
      : { root: p, only: null, access });
  }
  return out;
}

module.exports = { outsideRootsFrom, OUTSIDE_WORKSPACE };
