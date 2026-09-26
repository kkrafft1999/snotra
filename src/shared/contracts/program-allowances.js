'use strict';

/**
 * Program allowances (#408): extra rights inside the sandbox for one program
 * the user trusts, in every workspace.
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

/** File name of a program path, whichever separator it uses. */
function programName(filePath) {
  if (typeof filePath !== 'string') return '';
  return filePath.split(/[\\/]/).pop() || '';
}

/**
 * An absolute POSIX path in plain form: no empty or dot segments, no trailing
 * slash. Null for anything else. Windows has no sandbox, so there is nothing
 * to allow there.
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

function normalizeAllowanceDomains(value) {
  return [...normalizeDomains(Array.isArray(value) ? value : [])]
    .slice(0, PROGRAM_ALLOWANCE_LIMITS.MAX_DOMAINS)
    .sort();
}

function normalizeWritePaths(value) {
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
 * @returns {{path: string, domains: string[], writePaths: string[], trustd: boolean}|null}
 */
function normalizeProgramAllowance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const path = normalizeAllowancePath(raw.path);
  if (!path || path === '/' || !programName(path)) return null;
  return {
    path,
    domains: normalizeAllowanceDomains(raw.domains),
    writePaths: normalizeWritePaths(raw.writePaths),
    trustd: raw.trustd === true,
  };
}

/** Each program once, in the order given, at most MAX_ENTRIES. */
function normalizeProgramAllowances(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = normalizeProgramAllowance(raw);
    if (!entry || out.some((other) => other.path === entry.path)) continue;
    out.push(entry);
    if (out.length >= PROGRAM_ALLOWANCE_LIMITS.MAX_ENTRIES) break;
  }
  return out;
}

/** Whether an allowance grants anything at all. */
function grantsSomething(entry) {
  return !!entry && (entry.domains.length > 0 || entry.writePaths.length > 0 || entry.trustd === true);
}

/**
 * The domain field of the dialog: host names separated by line breaks,
 * spaces or commas. `invalid` keeps what was typed and is not a host name, so
 * the dialog can say which entry it refuses instead of dropping it quietly.
 */
function parseDomainInput(text) {
  const raw = typeof text === 'string' ? text.slice(0, PROGRAM_ALLOWANCE_LIMITS.MAX_INPUT_CHARS) : '';
  const domains = [];
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
  grantsSomething,
  parseDomainInput,
  isNarrowing,
};
