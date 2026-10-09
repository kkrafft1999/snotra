'use strict';

/**
 * Paths outside the open folder a file tool may be given on a card (#792,
 * step 4) — and as what: exactly the file or folder the call names, or the
 * folder around it.
 *
 * The file tools work inside the open folder. A call that names a path
 * outside it is not refused any more when a card may offer it: the user sees
 * the path and opens exactly that, for the call or the session. What a card
 * offers is decided here, by the same lines the sandbox cards keep (#408,
 * #792 step 2), compared as given and by realpath, so that a link cannot
 * carry a grant somewhere else:
 *
 * - never the root of a disk, the home folder or anything above it;
 * - nothing in or around Snotra's own storage — its keys stay in the app;
 * - no folder around a location with credentials (`~/.ssh`, browser
 *   profiles, the keychain …); reading such a location exactly is offered,
 *   and the planner marks it sensitive as in the open folder;
 * - writing nowhere in or around those locations, the global skill folders,
 *   or the files no one should write for a tool (`.bashrc`, `.git/hooks` …);
 * - "the folder around it" never a folder many programs share
 *   (`~/Documents`, `~/Library/Caches`, `/tmp` …), see `widerFolder`.
 *
 * A grant is `{ path, file, access }`: `file` opens exactly that one file
 * (its folder is the root the file tools check against, the name the only
 * entry they may touch), otherwise the folder and everything inside it.
 */

const { isPathInside } = require('../../shared/runtime/path-inside');

/** What fs-service reports for a tool path outside the open folder: a card may offer it. */
const OUTSIDE_WORKSPACE = 'outside_workspace';
const { widerFolder } = require('./sandbox-violations');
const { sensitiveReadPaths, isAlwaysUnwritable } = require('./sandbox-service');

/**
 * @param {object} deps
 * @param {typeof import('path')} deps.path
 * @param {string} deps.homeDir
 * @param {string} [deps.platform]
 * @param {string} [deps.userDataPath]     Snotra's settings and key storage
 * @param {string[]} [deps.globalSkillRoots]  read-only for every tool (#548, #650)
 * @param {(p: string) => Promise<string>} [deps.realPath]  realpath of the nearest existing part
 */
function createOutsideAccess({
  path,
  homeDir,
  platform = process.platform,
  userDataPath = '',
  globalSkillRoots = [],
  realPath = async (p) => p,
}) {
  const home = path.resolve(homeDir);
  const expand = (p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  const own = typeof userDataPath === 'string' && userDataPath ? [path.resolve(userDataPath)] : [];
  const credentials = sensitiveReadPaths({ platform, userDataPath: '' }).map((p) => path.resolve(expand(p)));
  const skills = (Array.isArray(globalSkillRoots) ? globalSkillRoots : [])
    .filter((p) => typeof p === 'string' && p)
    .map((p) => path.resolve(p));

  const inside = (root, candidate) => isPathInside(path, root, candidate);
  const around = (a, b) => inside(a, b) || inside(b, a);
  /** Strictly inside: `root` contains `candidate` and is not it. */
  const below = (root, candidate) => inside(root, candidate) && path.resolve(root) !== path.resolve(candidate);

  async function spellings(p) {
    const out = [path.resolve(p)];
    try {
      const real = await realPath(p);
      if (typeof real === 'string' && real && !out.includes(real)) out.push(real);
    } catch {
      /* the path as given, then */
    }
    return out;
  }

  /** What one spelling of what a grant opens may be, for reading or writing. */
  function spellingAllowed(p, { access, exact }) {
    if (!path.isAbsolute(p)) return false;
    if (p === path.parse(p).root || inside(p, home)) return false;
    if (own.some((dir) => around(dir, p))) return false;
    if (access === 'write') {
      if (isAlwaysUnwritable(p)) return false;
      if ([...credentials, ...skills].some((dir) => around(dir, p))) return false;
      return true;
    }
    // Reading: a location with credentials only as exactly what the call
    // names, never as a folder that contains one, never one level wider.
    if (credentials.some((dir) => below(p, dir))) return false;
    if (!exact && credentials.some((dir) => inside(dir, p))) return false;
    return true;
  }

  /** Whether a grant may open what it names — checked again wherever a grant is used. */
  async function isAllowed(grant, { exact = true } = {}) {
    if (!grant || typeof grant.path !== 'string' || !path.isAbsolute(grant.path)) return false;
    const access = grant.access === 'write' ? 'write' : 'read';
    for (const p of await spellings(grant.path)) {
      if (!spellingAllowed(p, { access, exact })) return false;
    }
    return true;
  }

  /**
   * What a card may offer for one target outside the open folder: exactly it,
   * and the folder around it. Empty when nothing may be offered — the call is
   * then refused as before.
   *
   * @param {{ absPath: string, isDirectory: boolean, access: 'read'|'write' }} target
   * @returns {Promise<Array<{ path: string, file: boolean, access: 'read'|'write' }>>}
   */
  async function offer({ absPath, isDirectory, access }) {
    const p = path.resolve(absPath);
    const mode = access === 'write' ? 'write' : 'read';
    const out = [];
    const exact = { path: p, file: !isDirectory, access: mode };
    if (await isAllowed(exact, { exact: true })) out.push(exact);
    // The folder a file lies in, or the one above a folder.
    const wider = widerFolder(p, home);
    if (wider) {
      const grant = { path: wider, file: false, access: mode };
      if (await isAllowed(grant, { exact: false })) out.push(grant);
    }
    return out;
  }

  return { offer, isAllowed, expandHome: expand };
}

/**
 * The roots the file tools may use outside the open folder, from grants:
 * a folder grant is its folder, a file grant the file's folder with that one
 * name. Malformed entries are dropped.
 *
 * @returns {Array<{ root: string, only: string|null, access: 'read'|'write' }>}
 */
function outsideRootsFrom(grants, path) {
  const out = [];
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (!grant || typeof grant.path !== 'string' || !path.isAbsolute(grant.path)) continue;
    const p = path.resolve(grant.path);
    const access = grant.access === 'write' ? 'write' : 'read';
    out.push(grant.file === true
      ? { root: path.dirname(p), only: path.basename(p), access }
      : { root: p, only: null, access });
  }
  return out;
}

module.exports = { createOutsideAccess, outsideRootsFrom, OUTSIDE_WORKSPACE };
