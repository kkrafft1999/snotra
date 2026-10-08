'use strict';

/**
 * What the sandbox refused during one run, in a form the chat can show and
 * the model can act on (#792).
 *
 * The runtime records each refusal as one text line, in three dialects:
 *
 * - **macOS Seatbelt** (log monitor): `curl(4711) deny(1) file-write-create /Users/me/x`
 *   — also `file-read-*` for the protected locations and `network-outbound
 *   1.2.3.4:5432` for a connection that bypassed the proxy;
 * - **Linux** (seccomp observer, write intents only): `deny openat /home/me/x`;
 * - **the network proxy**: `deny network-outbound host:443 (host is not on the allow list)`
 *   and `deny http-request GET https://host/path (reason)`.
 *
 * The lines are parsed here, not guessed from stderr. A program that writes a
 * cache writes hundreds of files, so writes are folded into the folder they
 * share — as long as that folder is not one of the broad ones every program
 * shares (`~/Library/Caches`, `~/.cache`, …), where folding would hide which
 * program it was.
 */

const KINDS = Object.freeze({
  /** A write outside the workspace and the run's temp directory. */
  WRITE: 'write',
  /** A read of a location the sandbox keeps closed (credentials, profiles). */
  READ: 'read',
  /** A connection through the sandbox's proxy to a host the run may not reach. */
  NETWORK: 'network',
  /** A connection that bypassed the proxy (`psql`, `ssh`, …); never allowable. */
  DIRECT: 'direct',
  /** Anything else the sandbox refused (system services, sockets, sysctl); not shown. */
  OTHER: 'other',
});

/** Lines kept for the raw view; the runtime keeps at most 100 itself. */
const MAX_RAW_LINES = 100;
/** Entries kept after grouping; the rest is counted, not listed. */
const MAX_ENTRIES = 20;

const SEATBELT_LINE = /^(.*)\((\d+)\) deny\(\d+\) (\S+)(?: (.*))?$/;
const PROXY_OUTBOUND = /^deny network-outbound (\S+) \((.*)\)$/;
const PROXY_REQUEST = /^deny http-request (\S+) (\S+) \((.*)\)$/;
const LINUX_LINE = /^deny (\S+) (\/.*)$/;

/**
 * @param {string} line  one violation line as the runtime stored it
 * @returns {{kind: string, target: string, operation: string, process?: string, reason?: string}|null}
 */
function parseViolationLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;

  let m = PROXY_OUTBOUND.exec(text);
  if (m) return { kind: KINDS.NETWORK, target: m[1], operation: 'network-outbound', reason: m[2] };

  m = PROXY_REQUEST.exec(text);
  if (m) {
    return { kind: KINDS.NETWORK, target: hostOfUrl(m[2]) || m[2], operation: `http-request ${m[1]}`, reason: m[3] };
  }

  m = SEATBELT_LINE.exec(text);
  if (m) {
    const [, process, , operation, rest = ''] = m;
    const target = rest.trim();
    const base = { operation, process: process.trim(), target };
    if (operation.startsWith('file-write')) return { ...base, kind: KINDS.WRITE };
    if (operation.startsWith('file-read')) return { ...base, kind: KINDS.READ };
    // A path is a local socket, not a host: nothing left the machine.
    if (operation === 'network-outbound' && target && !target.startsWith('/')) return { ...base, kind: KINDS.DIRECT };
    return { ...base, kind: KINDS.OTHER };
  }

  // The kernel reports write *attempts*; the runtime filters them against the
  // lists it had at start, before any run had a workspace (`observed`).
  m = LINUX_LINE.exec(text);
  if (m) return { kind: KINDS.WRITE, target: m[2], operation: m[1], observed: true };

  return { kind: KINDS.OTHER, target: '', operation: text };
}

function hostOfUrl(url) {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : `${u.hostname}:${u.protocol === 'http:' ? 80 : 443}`;
  } catch {
    return '';
  }
}

/** Folders many programs share: a group that only has one of these in common is not one program's. */
function broadFolders(homeDir) {
  const home = trimSlash(homeDir);
  const shared = ['/', '/Users', '/home', '/private', '/private/var', '/private/var/folders', '/private/tmp',
    '/tmp', '/var', '/var/folders', '/var/tmp', '/opt', '/usr', '/usr/local', '/etc', '/Library',
    '/Library/Caches', '/Applications'];
  if (!home) return new Set(shared);
  const inHome = ['', '/Library', '/Library/Caches', '/Library/Application Support', '/Library/Preferences',
    '/Library/Containers', '/Library/Group Containers', '/Library/Logs', '/.cache', '/.config', '/.local',
    '/.local/share', '/.local/state', '/Documents', '/Desktop', '/Downloads'];
  return new Set([...shared, ...inHome.map((p) => `${home}${p}`)]);
}

function trimSlash(p) {
  const s = String(p || '');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

function parentOf(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function commonFolder(a, b) {
  const pa = a.split('/');
  const pb = b.split('/');
  const out = [];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i] === pb[i]; i += 1) out.push(pa[i]);
  return out.join('/') || '/';
}

/**
 * Folds written paths into groups that share a folder below the broad ones.
 * Returns `{ target, folder, count }`: `folder` is true when the target is a
 * folder that stands for several written paths.
 */
function groupWrites(paths, homeDir) {
  const broad = broadFolders(homeDir);
  const groups = [];
  for (const path of [...new Set(paths)].sort()) {
    const g = groups.find((x) => !broad.has(commonFolder(x.folder ? x.target : parentOf(x.target), parentOf(path))));
    if (g) {
      g.target = commonFolder(g.folder ? g.target : parentOf(g.target), parentOf(path));
      g.folder = true;
      g.count += 1;
    } else {
      groups.push({ target: path, folder: false, count: 1 });
    }
  }
  return groups;
}

/**
 * Every Seatbelt run refuses a few system queries (`sysctl-read
 * kern.iossupportversion`, `system-info`, `mach-lookup`) that no program
 * needs to succeed; those are left out, and a run that only had those has
 * nothing to show.
 *
 * On Linux the observer reports what the kernel saw a program *try*, checked
 * against the write rules the runtime had when it started — without the
 * workspace of any run. `isPermittedWrite` checks such an attempt against the
 * run's own rules, and an attempt the run was allowed is no refusal.
 *
 * @param {string[]} lines  the run's violation lines, oldest first
 * @param {{homeDir?: string, isPermittedWrite?: (path: string) => boolean}} [options]
 * @returns {null | {
 *   entries: Array<{kind: string, target: string, count: number, folder?: boolean, operations: string[], reason?: string}>,
 *   moreEntries: number,
 *   total: number,
 *   raw: string[],
 * }}
 */
function summarizeViolations(lines, { homeDir = '', isPermittedWrite } = {}) {
  const list = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? '').trim()).filter(Boolean);
  if (list.length === 0) return null;
  const permitted = typeof isPermittedWrite === 'function' ? isPermittedWrite : () => false;
  const parsed = list.map(parseViolationLine).map((p) => (p?.observed && permitted(p.target) ? null : p));

  const entries = [];
  const byKey = new Map();
  // `count` is the number of paths a write group stands for, and the number
  // of refusals for everything else.
  const add = (kind, target, operation, { count = 1, ...extra } = {}) => {
    const key = `${kind}\u0000${target}`;
    let e = byKey.get(key);
    if (!e) {
      e = { kind, target, count: 0, operations: [], ...extra };
      byKey.set(key, e);
      entries.push(e);
    }
    e.count += count;
    if (operation && !e.operations.includes(operation)) e.operations.push(operation);
    return e;
  };

  const writes = parsed.filter((p) => p?.kind === KINDS.WRITE);
  const writeOps = new Map();
  for (const w of writes) {
    if (!writeOps.has(w.target)) writeOps.set(w.target, new Set());
    writeOps.get(w.target).add(w.operation);
  }
  for (const g of groupWrites(writes.map((w) => w.target), homeDir)) {
    const ops = new Set();
    for (const [path, set] of writeOps) {
      if (path === g.target || (g.folder && path.startsWith(`${g.target}/`))) set.forEach((o) => ops.add(o));
    }
    const e = add(KINDS.WRITE, g.target, '', { count: g.count, ...(g.folder ? { folder: true } : {}) });
    e.operations.push(...[...ops].sort());
  }
  for (const p of parsed) {
    if (!p || p.kind === KINDS.WRITE || p.kind === KINDS.OTHER) continue;
    const e = add(p.kind, p.target, p.operation);
    if (p.reason && !e.reason) e.reason = p.reason;
  }
  if (entries.length === 0) return null;

  const order = [KINDS.WRITE, KINDS.READ, KINDS.NETWORK, KINDS.DIRECT];
  entries.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const relevant = list.filter((l, i) => parsed[i] && parsed[i].kind !== KINDS.OTHER);
  return {
    entries: entries.slice(0, MAX_ENTRIES),
    moreEntries: Math.max(0, entries.length - MAX_ENTRIES),
    total: relevant.length,
    raw: relevant.slice(-MAX_RAW_LINES),
  };
}

/**
 * What the model reads about the refusals, in place of the runtime's raw
 * violation lines: one line per resource, then what to do.
 *
 * @param {ReturnType<typeof summarizeViolations>} summary
 */
function describeForModel(summary) {
  if (!summary || summary.entries.length === 0) return '';
  const label = {
    [KINDS.WRITE]: 'write outside the workspace',
    [KINDS.READ]: 'read of a protected location',
    [KINDS.NETWORK]: 'connection to a host outside network_domains',
    [KINDS.DIRECT]: 'direct connection that bypassed the sandbox proxy (cannot be allowed)',
  };
  const lines = summary.entries.map((e) => {
    const what = e.folder ? `${e.target}/ (${e.count} paths)` : e.target;
    return `- ${label[e.kind]}: ${what}${e.reason ? ` (${e.reason})` : ''}`;
  });
  if (summary.moreEntries > 0) lines.push(`- and ${summary.moreEntries} more`);
  const hasNetwork = summary.entries.some((e) => e.kind === KINDS.NETWORK);
  return [
    '<sandbox_blocked>',
    'The sandbox refused the following during this run. The user sees the same list in the chat.',
    ...lines,
    'Do not work around it: no other location, tool, environment variable or setting to get past the sandbox. '
      + 'Tell the user what was blocked and why the task needs it.'
      + (hasNetwork ? ' A host the task really needs may be named in network_domains of a new call, which the user approves.' : ''),
    '</sandbox_blocked>',
  ].join('\n');
}

module.exports = {
  KINDS,
  MAX_ENTRIES,
  MAX_RAW_LINES,
  parseViolationLine,
  summarizeViolations,
  describeForModel,
  groupWrites,
};
