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
 *                runs outside the sandbox and can reach the network itself;
 * - `credentials` environment variables whose values are secrets, such as
 *                `GH_TOKEN` for `gh` (#1262). The entry holds each variable's
 *                name and the id its value is stored under — never the
 *                value, which main keeps encrypted next to the allowances
 *                and decrypts only for a run that matches.
 *
 * Shared by main (store, IPC, planner) and the renderer (settings dialog), so
 * both read an entry the same way. A broken entry normalizes to null and is
 * dropped: it must never turn into a wider allowance than the user saw.
 */

const { normalizeDomains } = require('../runtime/sandbox-domains');
const { isRecord } = require('../runtime/is-record');

/**
 * @typedef {Object} AllowanceCredential
 * @property {string} name  the environment variable, e.g. `GH_TOKEN`
 * @property {string} id    where its value is stored; a new value gets a new id
 *
 * @typedef {Object} ProgramAllowance
 * @property {string} path
 * @property {string[]} domains
 * @property {string[]} writePaths
 * @property {boolean} trustd
 * @property {AllowanceCredential[]} credentials
 */

const PROGRAM_ALLOWANCE_LIMITS = Object.freeze({
  MAX_ENTRIES: 20,
  MAX_DOMAINS: 20,
  MAX_WRITE_PATHS: 10,
  MAX_PATH_CHARS: 1024,
  MAX_INPUT_CHARS: 4000,
  MAX_CREDENTIALS: 5,
  MAX_CREDENTIAL_NAME_CHARS: 64,
  // The same lower bound as the masking of Snotra's own secrets: a shorter
  // value turns up in any output by chance and could not be masked.
  MIN_SECRET_CHARS: 8,
  MAX_SECRET_CHARS: 4096,
});

/** Why a credential's variable name is refused (#1262). */
const CREDENTIAL_NAME_PROBLEMS = Object.freeze({
  EMPTY: 'empty',
  INVALID: 'invalid',
  /** Set by the shell or the sandbox, or changes how a program starts. */
  RESERVED: 'reserved',
});

/** Why a credential's value is refused (#1262). */
const CREDENTIAL_VALUE_PROBLEMS = Object.freeze({
  EMPTY: 'empty',
  SHORT: 'short',
  LONG: 'long',
  /** A line break or a NUL: no environment variable can carry it. */
  INVALID: 'invalid',
});

const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Variables a credential must not replace, compared in upper case: what the
 * shell and the sandbox set for every run, and what decides how a shell
 * starts. The sandbox's own variables win anyway; refusing them here says so
 * before the user wonders why a run did not get the value.
 */
const RESERVED_CREDENTIAL_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'TMPDIR', 'TMP', 'TEMP',
  'IFS', 'ENV', 'BASH_ENV', 'ZDOTDIR', 'CDPATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY', 'GRPC_PROXY',
  'SSH_AUTH_SOCK', 'XDG_CACHE_HOME', 'PIP_CACHE_DIR', 'NPM_CONFIG_CACHE',
]);
const RESERVED_CREDENTIAL_PREFIXES = ['DYLD_', 'LD_', 'SNOTRA_'];

/**
 * The variable a program's own documentation names for a token. Anything
 * else gets `<PROGRAM>_TOKEN`; the field stays editable either way.
 *
 * @type {Readonly<Record<string, string>>}
 */
const SUGGESTED_CREDENTIAL_NAMES = Object.freeze({
  gh: 'GH_TOKEN',
  glab: 'GITLAB_TOKEN',
  hub: 'GITHUB_TOKEN',
  vercel: 'VERCEL_TOKEN',
  netlify: 'NETLIFY_AUTH_TOKEN',
  fly: 'FLY_API_TOKEN',
  flyctl: 'FLY_API_TOKEN',
  doctl: 'DIGITALOCEAN_ACCESS_TOKEN',
  hcloud: 'HCLOUD_TOKEN',
  heroku: 'HEROKU_API_KEY',
  wrangler: 'CLOUDFLARE_API_TOKEN',
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
 * Where a program reads its configuration from, for programs that keep it in
 * a place the sandbox keeps locked (#1262): `gh` and `glab` stop at once when
 * `~/.config/gh` or `~/.config/glab-cli` cannot be read. A run that gets its
 * token from the allowance has no use for that configuration; it gets an
 * empty folder of its own through this variable instead, and the lock stays.
 *
 * @type {Readonly<Record<string, string>>}
 */
const LOCKED_CONFIG_DIR_VARIABLES = Object.freeze({
  gh: 'GH_CONFIG_DIR',
  glab: 'GLAB_CONFIG_DIR',
});

/**
 * The variable that points a program at its configuration, when the sandbox
 * keeps its own one locked; '' for every other program.
 *
 * @param {unknown} programPath
 * @returns {string}
 */
function lockedConfigDirVariable(programPath) {
  const name = programName(programPath);
  return Object.hasOwn(LOCKED_CONFIG_DIR_VARIABLES, name) ? LOCKED_CONFIG_DIR_VARIABLES[name] : '';
}

/**
 * Whether a credential's variable name can be used, and why not (#1262).
 *
 * @param {unknown} value
 * @returns {string|null}  one of CREDENTIAL_NAME_PROBLEMS, or null
 */
function credentialNameProblem(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return CREDENTIAL_NAME_PROBLEMS.EMPTY;
  if (name.length > PROGRAM_ALLOWANCE_LIMITS.MAX_CREDENTIAL_NAME_CHARS || !CREDENTIAL_NAME.test(name)) {
    return CREDENTIAL_NAME_PROBLEMS.INVALID;
  }
  const upper = name.toUpperCase();
  if (RESERVED_CREDENTIAL_NAMES.has(upper) || RESERVED_CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return CREDENTIAL_NAME_PROBLEMS.RESERVED;
  }
  return null;
}

/**
 * Whether a typed secret can be stored, and why not (#1262). Spaces around
 * it are what a paste brings along and are not part of it.
 *
 * @param {unknown} value
 * @returns {string|null}  one of CREDENTIAL_VALUE_PROBLEMS, or null
 */
function credentialValueProblem(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return CREDENTIAL_VALUE_PROBLEMS.EMPTY;
  if (/[\0\r\n]/.test(text)) return CREDENTIAL_VALUE_PROBLEMS.INVALID;
  if (text.length < PROGRAM_ALLOWANCE_LIMITS.MIN_SECRET_CHARS) return CREDENTIAL_VALUE_PROBLEMS.SHORT;
  if (text.length > PROGRAM_ALLOWANCE_LIMITS.MAX_SECRET_CHARS) return CREDENTIAL_VALUE_PROBLEMS.LONG;
  return null;
}

/**
 * The variable the dialog proposes for a program's token (#1262).
 *
 * @param {unknown} programPath
 * @returns {string}  '' when the program name makes no variable name
 */
function suggestedCredentialName(programPath) {
  const name = programName(programPath).toLowerCase();
  if (!name) return '';
  if (Object.hasOwn(SUGGESTED_CREDENTIAL_NAMES, name)) return SUGGESTED_CREDENTIAL_NAMES[name];
  const derived = `${name.replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()}_TOKEN`;
  return credentialNameProblem(derived) === null ? derived : '';
}

/**
 * An allowance's credentials: valid name and id, each name and each id
 * once, at most MAX_CREDENTIALS, sorted by name.
 *
 * @param {unknown} value
 * @returns {AllowanceCredential[]}
 */
function normalizeCredentials(value) {
  /** @type {AllowanceCredential[]} */
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.id !== 'string') continue;
    const name = raw.name.trim();
    if (credentialNameProblem(name) !== null || !CREDENTIAL_ID.test(raw.id)) continue;
    if (out.some((other) => other.name === name || other.id === raw.id)) continue;
    out.push({ name, id: raw.id });
    if (out.length >= PROGRAM_ALLOWANCE_LIMITS.MAX_CREDENTIALS) break;
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
    credentials: normalizeCredentials(raw.credentials),
  };
}

/**
 * The credentials of two allowances for one program, added up (#1119,
 * #1262): every variable of either; where both name the same variable, the
 * one of `own` — the workspace's — wins.
 *
 * @param {AllowanceCredential[]} base
 * @param {AllowanceCredential[]} own
 * @returns {AllowanceCredential[]}
 */
function combineCredentials(base, own) {
  return [...base.filter((entry) => !own.some((other) => other.name === entry.name)), ...own];
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
  return domains.size > PROGRAM_ALLOWANCE_LIMITS.MAX_DOMAINS
    || folders.size > PROGRAM_ALLOWANCE_LIMITS.MAX_WRITE_PATHS
    || combineCredentials(a.credentials, b.credentials).length > PROGRAM_ALLOWANCE_LIMITS.MAX_CREDENTIALS;
}

/**
 * What applies in one workspace (#1119): the allowances for every workspace
 * and the workspace's own, one entry per program. Where both name the same
 * program they add up — every domain and folder of either, the macOS
 * certificate check when either has it, and every credential of either, the
 * workspace's where both set the same variable (#1262).
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
      credentials: combineCredentials(base.credentials, own.credentials),
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
  return !!entry && (entry.domains.length > 0 || entry.writePaths.length > 0 || entry.trustd === true
    || (entry.credentials?.length ?? 0) > 0);
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
 * domain, no new folder, trustd not newly on, no credential that `previous`
 * did not hand over under the same name with the same value (#1262). Such a
 * change needs no confirmation — like switching the sandbox back on.
 *
 * @param {ProgramAllowance|null|undefined} previous
 * @param {ProgramAllowance|null|undefined} next
 * @returns {boolean}
 */
function isNarrowing(previous, next) {
  if (!previous || !next || previous.path !== next.path) return false;
  if (next.trustd && !previous.trustd) return false;
  if (next.domains.some((domain) => !previous.domains.includes(domain))) return false;
  // An entry written before #1262 has no credentials.
  const before = previous.credentials || [];
  if (!(next.credentials || []).every((entry) => before.some((other) => other.id === entry.id && other.name === entry.name))) {
    return false;
  }
  return next.writePaths.every((entry) => previous.writePaths.includes(entry));
}

module.exports = {
  PROGRAM_ALLOWANCE_LIMITS,
  PROGRAM_ALLOWANCE_SKIP_REASONS,
  CREDENTIAL_NAME_PROBLEMS,
  CREDENTIAL_VALUE_PROBLEMS,
  programName,
  credentialNameProblem,
  credentialValueProblem,
  suggestedCredentialName,
  lockedConfigDirVariable,
  normalizeCredentials,
  normalizeAllowancePath,
  normalizeProgramAllowance,
  normalizeProgramAllowances,
  combineProgramAllowances,
  combinationTooLarge,
  grantsSomething,
  parseDomainInput,
  isNarrowing,
};
