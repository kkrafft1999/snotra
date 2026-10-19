'use strict';

/**
 * Program allowances (#408): extra rights inside the sandbox for one program
 * the user trusts — in one workspace or in every workspace (#1119).
 *
 * An allowance names the program by its file path and adds, for runs that
 * start exactly that file on its own:
 * - `domains`    hosts it may reach, on top of what the model declares;
 * - `writePaths` folders it may write in besides the project folder, such as
 *                a tool's own token cache;
 * - `trustd`     whether it may check certificates through the macOS trust
 *                service. Programs written in Go need that for any TLS
 *                connection; the sandbox keeps it closed because the service
 *                runs outside the sandbox and can reach the network itself.
 *
 * Shared by main (store, IPC, planner) and the renderer (settings dialog), so
 * both read an entry the same way. A broken entry normalizes to null and is
 * dropped: it must never turn into a wider allowance than the user saw.
 */

const { normalizeDomains } = require('../runtime/sandbox-domains');
const { isRecord } = require('../runtime/is-record');

/**
 * @typedef {Object} ProgramAllowance
 * @property {string} path
 * @property {string[]} domains
 * @property {string[]} writePaths
 * @property {boolean} trustd
 */

const PROGRAM_ALLOWANCE_LIMITS = Object.freeze({
  MAX_ENTRIES: 20,
  MAX_DOMAINS: 20,
  MAX_WRITE_PATHS: 10,
  MAX_PATH_CHARS: 1024,
  MAX_INPUT_CHARS: 4000,
});

/** Why an allowance that names the program does not apply to a run. */
const PROGRAM_ALLOWANCE_SKIP_REASONS = Object.freeze({
  /** Chained, piped, redirected, a variable set in front — more than the program. */
  COMPOUND: 'compound',
  /** `$…` or backticks: what runs is only known once the shell expanded it. */
  EXPANSION: 'expansion',
  /** A file of the same name, but not the one the allowance names. */
  OTHER_FILE: 'otherFile',
});

/**
 * File name of a program path, whichever separator it uses.
 *
 * @param {unknown} filePath
 * @returns {string}
 */
function programName(filePath) {
  if (typeof filePath !== 'string') return '';
  return filePath.split(/[\\/]/).pop() || '';
}

/**
 * An absolute POSIX path in plain form: no empty or dot segments, no trailing
 * slash. Null for anything else. Windows has no sandbox, so there is nothing
 * to allow there.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeAllowancePath(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text.startsWith('/') || text.length > PROGRAM_ALLOWANCE_LIMITS.MAX_PATH_CHARS) return null;
  if (/[\0\r\n]/.test(text)) return null;
  const segments = text.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return `/${segments.join('/')}`;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeAllowanceDomains(value) {
  return [...normalizeDomains(Array.isArray(value) ? value : [])]
    .slice(0, PROGRAM_ALLOWANCE_LIMITS.MAX_DOMAINS)
    .sort();
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeWritePaths(value) {
  /** @type {string[]} */
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const normalized = normalizeAllowancePath(entry);
    if (!normalized || normalized === '/' || out.includes(normalized)) continue;
    out.push(normalized);
    if (out.length >= PROGRAM_ALLOWANCE_LIMITS.MAX_WRITE_PATHS) break;
  }
  return out.sort();
}

/**
 * @param {unknown} raw
 * @returns {ProgramAllowance|null}
 */
function normalizeProgramAllowance(raw) {
  if (!isRecord(raw)) return null;
  const path = normalizeAllowancePath(raw.path);
  if (!path || path === '/' || !programName(path)) return null;
  return {
    path,
    domains: normalizeAllowanceDomains(raw.domains),
    writePaths: normalizeWritePaths(raw.writePaths),
    trustd: raw.trustd === true,
  };
}

/**
 * Each program once, in the order given, at most MAX_ENTRIES.
 *
 * @param {unknown} list
 * @returns {ProgramAllowance[]}
 */
function normalizeProgramAllowances(list) {
  /** @type {ProgramAllowance[]} */
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = normalizeProgramAllowance(raw);
    if (!entry || out.some((other) => other.path === entry.path)) continue;
    out.push(entry);
    if (out.length >= PROGRAM_ALLOWANCE_LIMITS.MAX_ENTRIES) break;
  }
  return out;
}

/**
 * Whether a global and a workspace allowance for the same program would,
 * added up (#1119), hold more domains or folders than one allowance may. The
 * store refuses such a pair rather than let a run get less than either of
 * them names — a run never takes more than one allowance's worth.
 *
 * @param {ProgramAllowance|null|undefined} a
 * @param {ProgramAllowance|null|undefined} b
 * @returns {boolean}
 */
function combinationTooLarge(a, b) {
  if (!a || !b || a.path !== b.path) return false;
  const domains = new Set([...a.domains, ...b.domains]);
  const folders = new Set([...a.writePaths, ...b.writePaths]);
  return domains.size > PROGRAM_ALLOWANCE_LIMITS.MAX_DOMAINS || folders.size > PROGRAM_ALLOWANCE_LIMITS.MAX_WRITE_PATHS;
}

/**
 * What applies in one workspace (#1119): the allowances for every workspace
 * and the workspace's own, one entry per program. Where both name the same
 * program they add up — every domain and folder of either, and the macOS
 * certificate check when either has it.
 *
 * @param {unknown} globalList
 * @param {unknown} workspaceList
 * @returns {ProgramAllowance[]}
 */
function combineProgramAllowances(globalList, workspaceList) {
  const out = normalizeProgramAllowances(globalList).map((entry) => ({ ...entry }));
  for (const own of normalizeProgramAllowances(workspaceList)) {
    const index = out.findIndex((entry) => entry.path === own.path);
    if (index < 0) {
      out.push(own);
      continue;
    }
    const base = out[index];
    // Both inputs are normalized, so the sum is too; `base` only satisfies the type.
    out[index] = normalizeProgramAllowance({
      path: base.path,
      domains: [...base.domains, ...own.domains],
      writePaths: [...base.writePaths, ...own.writePaths],
      trustd: base.trustd || own.trustd,
    }) ?? base;
  }
  return out;
}

/**
 * Whether an allowance grants anything at all.
 *
 * @param {ProgramAllowance|null|undefined} entry
 * @returns {boolean}
 */
function grantsSomething(entry) {
  return !!entry && (entry.domains.length > 0 || entry.writePaths.length > 0 || entry.trustd === true);
}

/**
 * The domain field of the dialog: host names separated by line breaks,
 * spaces or commas. `invalid` keeps what was typed and is not a host name, so
 * the dialog can say which entry it refuses instead of dropping it quietly.
 *
 * @param {unknown} text
 * @returns {{ domains: string[], invalid: string[], tooMany: boolean }}
 */
function parseDomainInput(text) {
  const raw = typeof text === 'string' ? text.slice(0, PROGRAM_ALLOWANCE_LIMITS.MAX_INPUT_CHARS) : '';
  /** @type {string[]} */
  const domains = [];
  /** @type {string[]} */
  const invalid = [];
  for (const token of raw.split(/[\s,;]+/)) {
    if (!token) continue;
    const [normalized] = normalizeDomains([token]);
    if (!normalized) {
      if (!invalid.includes(token)) invalid.push(token);
    } else if (!domains.includes(normalized)) {
      domains.push(normalized);
    }
  }
  return { domains, invalid, tooMany: domains.length > PROGRAM_ALLOWANCE_LIMITS.MAX_DOMAINS };
}

/**
 * Whether `next` only takes rights away from `previous`: same program, no new
 * domain, no new folder, trustd not newly on. Such a change needs no
 * confirmation — like switching the sandbox back on.
 *
 * @param {ProgramAllowance|null|undefined} previous
 * @param {ProgramAllowance|null|undefined} next
 * @returns {boolean}
 */
function isNarrowing(previous, next) {
  if (!previous || !next || previous.path !== next.path) return false;
  if (next.trustd && !previous.trustd) return false;
  if (next.domains.some((domain) => !previous.domains.includes(domain))) return false;
  return next.writePaths.every((entry) => previous.writePaths.includes(entry));
}

module.exports = {
  PROGRAM_ALLOWANCE_LIMITS,
  PROGRAM_ALLOWANCE_SKIP_REASONS,
  programName,
  normalizeAllowancePath,
  normalizeProgramAllowance,
  normalizeProgramAllowances,
  combineProgramAllowances,
  combinationTooLarge,
  grantsSomething,
  parseDomainInput,
  isNarrowing,
};
