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

// The roots a grant opens, and the refusal code a card may answer, are the
// planner's rules (#982); they live next to it in the application layer.
const { outsideRootsFrom, OUTSIDE_WORKSPACE } = require('../../application/tools/outside-roots');
const { widerFolder } = require('./sandbox-violations');
const { sensitiveReadPaths, isAlwaysUnwritable } = require('./sandbox-service');

/**
 * What a card may offer, and what is checked again wherever it is used: a
 * folder grant is its folder, a file grant that one file.
 * @typedef {{ path: string, file: boolean, access: 'read'|'write' }} OutsideGrant
 */

/**
 * @param {object} deps
 * @param {typeof import('path')} deps.path
 * @param {string} deps.homeDir
 * @param {string} [deps.platform]
 * @param {string} [deps.userDataPath]     Snotra's settings and key storage
 * @param {string[]} [deps.globalSkillRoots]  read-only for every tool (#548, #650)
 * @param {string[]} [deps.globalKnowledgePaths]  the global knowledge files and folders, read-only as well (#1319)
 * @param {(p: string) => Promise<string>} [deps.realPath]  realpath of the nearest existing part
 */
function createOutsideAccess({
  path,
  homeDir,
  platform = process.platform,
  userDataPath = '',
  globalSkillRoots = [],
  globalKnowledgePaths = [],
  realPath = async (p) => p,
}) {
  const home = path.resolve(homeDir);
  const expand = (/** @type {string} */ p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  const own = typeof userDataPath === 'string' && userDataPath ? [path.resolve(userDataPath)] : [];
  const credentials = sensitiveReadPaths({ platform, userDataPath: '' }).map((p) => path.resolve(expand(p)));
  const skills = [
    ...(Array.isArray(globalSkillRoots) ? globalSkillRoots : []),
    ...(Array.isArray(globalKnowledgePaths) ? globalKnowledgePaths : []),
  ]
    .filter((p) => typeof p === 'string' && p)
    .map((p) => path.resolve(p));

  const inside = (/** @type {string} */ root, /** @type {string} */ candidate) => isPathInside(path, root, candidate);
  const around = (/** @type {string} */ a, /** @type {string} */ b) => inside(a, b) || inside(b, a);
  /** Strictly inside: `root` contains `candidate` and is not it. */
  const below = (/** @type {string} */ root, /** @type {string} */ candidate) => inside(root, candidate) && path.resolve(root) !== path.resolve(candidate);

  /**
   * @param {string} p
   * @returns {Promise<string[]>}
   */
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

  /**
   * What one spelling of what a grant opens may be, for reading or writing.
   *
   * @param {string} p
   * @param {{ access: 'read'|'write', exact: boolean }} mode
   */
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

  /**
   * Whether a grant may open what it names — checked again wherever a grant is used.
   *
   * @param {{ path?: unknown, access?: unknown } | null | undefined} grant
   * @param {{ exact?: boolean }} [options]
   */
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
    /** @type {'read'|'write'} */
    const mode = access === 'write' ? 'write' : 'read';
    /** @type {OutsideGrant[]} */
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

module.exports = { createOutsideAccess, outsideRootsFrom, OUTSIDE_WORKSPACE };
