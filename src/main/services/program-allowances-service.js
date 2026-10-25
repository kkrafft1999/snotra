'use strict';

/**
 * Program allowances in main (#408): which program a name means, whether a
 * command runs exactly that program, and whether a folder may be handed out.
 *
 * Identity is the file, not the name. A command earns an allowance only when
 * it is one simple command (see `simple-command.js`) whose program resolves
 * — through the PATH the shell detection read (#111) — to the same real file
 * the allowance names. The line that then runs starts with that file's
 * absolute path instead of the typed name, so neither a PATH entry of the
 * shell nor a file of the same name in the project folder can put another
 * program in its place between the check and the run.
 */

const {
  programName,
  normalizeAllowancePath,
  normalizeProgramAllowance,
  parseDomainInput,
  grantsSomething,
  credentialNameProblem,
  credentialValueProblem,
  CREDENTIAL_NAME_PROBLEMS,
  CREDENTIAL_VALUE_PROBLEMS,
  PROGRAM_ALLOWANCE_LIMITS,
} = require('../../shared/contracts/program-allowances');
const { createMessage } = require('../../shared/contracts/message');
const { isRecord } = require('../../shared/runtime/is-record');
const { createProgramAllowanceMatcher } = require('../../application/permissions/program-allowance-match');
const { PLATFORM_CAPABILITIES } = require('../../shared/contracts/platform-capabilities');
const { platformSupports } = require('../platforms');

/**
 * @typedef {import('../../shared/contracts/program-allowances').ProgramAllowance} ProgramAllowance
 * @typedef {import('../../shared/contracts/message').Message} Message
 */

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {typeof import('os')} deps.os
 * @param {string} [deps.platform]
 * @param {() => Promise<string>} [deps.readUserPath]  the PATH of the user's shell
 * @param {(workspaceRoot: string|null) => Promise<unknown[]>} [deps.readAllowances]
 *   the allowances that apply in a workspace: its own and the global ones,
 *   added up per program (#1119)
 * @param {string[]} [deps.protectedRoots]  Snotra's own storage, never writable
 * @param {string[]} [deps.sensitivePaths]  what the sandbox keeps unreadable (`~` allowed)
 * @param {() => string} [deps.randomId]  the id a new credential value is stored under (#1262)
 */
function createProgramAllowances({
  fs,
  path,
  os,
  platform = process.platform,
  readUserPath = async () => '',
  readAllowances = async () => [],
  protectedRoots = [],
  sensitivePaths = [],
  randomId = () => require('crypto').randomUUID(),
}) {
  const X_OK = fs?.constants?.X_OK ?? 1;
  const home = os.homedir();

  /** @param {string} value */
  function expandHome(value) {
    if (value === '~') return home;
    return value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  }

  /** @param {string} target */
  async function realpathOrNull(target) {
    try {
      return await fs.realpath(target);
    } catch {
      return null;
    }
  }

  /** @param {string} target */
  async function isExecutableFile(target) {
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) return false;
      await fs.access(target, X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The file a command word starts, the way the shell would find it: a word
   * with a slash is a path (relative to `cwd`), a bare name is looked up in
   * the PATH — relative PATH entries included, so a `.` in it finds the
   * project's file first and the comparison fails, as it should.
   *
   * @param {unknown} word
   * @param {string|null|undefined} cwd
   * @returns {Promise<string|null>}
   */
  async function locate(word, cwd) {
    if (typeof word !== 'string' || !word || word.includes('\0')) return null;
    if (word.includes('/') || word === '~') {
      const expanded = expandHome(word);
      const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd || home, expanded);
      return (await isExecutableFile(absolute)) ? absolute : null;
    }
    const userPath = await readUserPath().catch(() => '');
    for (const entry of String(userPath || '').split(':')) {
      const dir = entry ? expandHome(entry) : '.';
      const candidate = path.resolve(cwd || home, dir, word);
      if (await isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  /**
   * What the settings dialog typed as "program": a bare name, `~/…` or an
   * absolute path. A relative path has no folder to be relative to here.
   *
   * @param {unknown} text
   * @returns {Promise<{ok: true, path: string, name: string}|{ok: false, error: Message}>}
   */
  async function resolveProgram(text) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) return { ok: false, error: createMessage('permissions.allowance.error.noProgram') };
    if (value.length > PROGRAM_ALLOWANCE_LIMITS.MAX_PATH_CHARS) {
      return { ok: false, error: createMessage('permissions.allowance.error.programNotFound', { program: value.slice(0, 80) }) };
    }
    if (value.includes('/') && !value.startsWith('/') && !value.startsWith('~/')) {
      return { ok: false, error: createMessage('permissions.allowance.error.relativeProgram') };
    }
    const found = await locate(value, home);
    const normalized = found ? normalizeAllowancePath(found) : null;
    if (!normalized) {
      return { ok: false, error: createMessage('permissions.allowance.error.programNotFound', { program: value }) };
    }
    return { ok: true, path: normalized, name: programName(normalized) };
  }

  /**
   * @param {string} root
   * @param {string} candidate
   */
  function contains(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /**
   * A folder the user wants the program to write in. Refused: anything that
   * does not exist, the file system root, the home folder and what lies above
   * it, Snotra's own storage, and every place the sandbox keeps unreadable —
   * or a folder around one of those.
   *
   * @param {unknown} raw
   * @returns {Promise<{ok: true, path: string}|{ok: false, error: Message}>}
   */
  async function validateWritePath(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    const absolute = normalizeAllowancePath(expandHome(text));
    if (!absolute) return { ok: false, error: createMessage('permissions.allowance.error.folderInvalid', { folder: text.slice(0, 200) }) };
    /** @type {import('fs').Stats|null} */
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      return { ok: false, error: createMessage('permissions.allowance.error.folderMissing', { folder: absolute }) };
    }
    const real = (await realpathOrNull(absolute)) || absolute;
    const realHome = (await realpathOrNull(home)) || home;
    for (const candidate of new Set([absolute, real])) {
      if (candidate === '/' || contains(candidate, realHome) || contains(candidate, home)) {
        return { ok: false, error: createMessage('permissions.allowance.error.folderTooBroad', { folder: absolute }) };
      }
    }
    const guarded = [...protectedRoots, ...sensitivePaths]
      .filter((entry) => typeof entry === 'string' && entry)
      .map((entry) => path.resolve(expandHome(entry)));
    for (const root of guarded) {
      const realRoot = (await realpathOrNull(root)) || root;
      for (const candidate of new Set([absolute, real])) {
        for (const guard of new Set([root, realRoot])) {
          if (contains(guard, candidate) || contains(candidate, guard)) {
            return { ok: false, error: createMessage('permissions.allowance.error.folderProtected', { folder: absolute }) };
          }
        }
      }
    }
    return { ok: true, path: absolute };
  }

  /**
   * The credentials the dialog sends (#1262): each a variable name and
   * either a new value or the id of the value the edited entry already has —
   * the store checks that the id is really that entry's. A new value gets a
   * new id, so a plan approved for the old one no longer runs.
   *
   * @param {unknown} list
   * @returns {{ok: true, credentials: Array<{name: string, id: string}>, secrets: Record<string, string>}
   *   | {ok: false, error: Message}}
   */
  function prepareCredentials(list) {
    const rows = Array.isArray(list) ? list : [];
    if (rows.length > PROGRAM_ALLOWANCE_LIMITS.MAX_CREDENTIALS) {
      return { ok: false, error: createMessage('permissions.allowance.error.tooManyCredentials', { max: PROGRAM_ALLOWANCE_LIMITS.MAX_CREDENTIALS }) };
    }
    /** @type {Array<{name: string, id: string}>} */
    const credentials = [];
    /** @type {Record<string, string>} */
    const secrets = {};
    for (const raw of rows) {
      const row = isRecord(raw) ? raw : {};
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const nameProblem = credentialNameProblem(name);
      if (nameProblem === CREDENTIAL_NAME_PROBLEMS.EMPTY) {
        return { ok: false, error: createMessage('permissions.allowance.error.credentialNameEmpty') };
      }
      if (nameProblem === CREDENTIAL_NAME_PROBLEMS.RESERVED) {
        return { ok: false, error: createMessage('permissions.allowance.error.credentialNameReserved', { name }) };
      }
      if (nameProblem) {
        return { ok: false, error: createMessage('permissions.allowance.error.credentialNameInvalid', { name: name.slice(0, 80) }) };
      }
      if (credentials.some((other) => other.name === name)) {
        return { ok: false, error: createMessage('permissions.allowance.error.credentialNameTwice', { name }) };
      }
      const value = typeof row.value === 'string' ? row.value.trim() : '';
      if (value) {
        const valueProblem = credentialValueProblem(value);
        if (valueProblem) {
          const key = valueProblem === CREDENTIAL_VALUE_PROBLEMS.SHORT
            ? 'permissions.allowance.error.credentialValueShort'
            : valueProblem === CREDENTIAL_VALUE_PROBLEMS.LONG
              ? 'permissions.allowance.error.credentialValueLong'
              : 'permissions.allowance.error.credentialValueInvalid';
          return {
            ok: false,
            error: createMessage(key, {
              name,
              min: PROGRAM_ALLOWANCE_LIMITS.MIN_SECRET_CHARS,
              max: PROGRAM_ALLOWANCE_LIMITS.MAX_SECRET_CHARS,
            }),
          };
        }
        const id = randomId();
        secrets[id] = value;
        credentials.push({ name, id });
      } else if (typeof row.id === 'string' && row.id) {
        credentials.push({ name, id: row.id });
      } else {
        return { ok: false, error: createMessage('permissions.allowance.error.credentialValueEmpty', { name }) };
      }
    }
    return { ok: true, credentials, secrets };
  }

  /**
   * The entry the settings dialog wants to store, checked the way main sees
   * the machine: program resolved, every domain a host name, every folder
   * allowed, every credential named and filled (#1262). trustd only exists
   * on macOS. `secrets` carries the new credential values for the store.
   *
   * @param {unknown} raw
   * @returns {Promise<{ok: true, entry: ProgramAllowance, secrets: Record<string, string>}|{ok: false, error: Message}>}
   */
  async function prepareEntry(raw) {
    /** @type {Record<string, unknown>} */
    const data = isRecord(raw) ? raw : {};
    const program = await resolveProgram(data.program);
    if (!program.ok) return program;
    const domainText = Array.isArray(data.domains) ? data.domains.filter((d) => typeof d === 'string').join('\n') : '';
    const parsed = parseDomainInput(domainText);
    if (parsed.invalid.length > 0) {
      return { ok: false, error: createMessage('permissions.allowance.error.invalidDomains', { domains: parsed.invalid.slice(0, 5).join(', ') }) };
    }
    if (parsed.tooMany) {
      return { ok: false, error: createMessage('permissions.allowance.error.tooManyDomains', { max: PROGRAM_ALLOWANCE_LIMITS.MAX_DOMAINS }) };
    }
    const folders = Array.isArray(data.writePaths) ? data.writePaths : [];
    if (folders.length > PROGRAM_ALLOWANCE_LIMITS.MAX_WRITE_PATHS) {
      return { ok: false, error: createMessage('permissions.allowance.error.tooManyFolders', { max: PROGRAM_ALLOWANCE_LIMITS.MAX_WRITE_PATHS }) };
    }
    /** @type {string[]} */
    const writePaths = [];
    for (const folder of folders) {
      const checked = await validateWritePath(folder);
      if (!checked.ok) return checked;
      writePaths.push(checked.path);
    }
    const credentials = prepareCredentials(data.credentials);
    if (!credentials.ok) return credentials;
    const entry = normalizeProgramAllowance({
      path: program.path,
      domains: parsed.domains,
      writePaths,
      trustd: platform === 'darwin' && data.trustd === true,
      credentials: credentials.credentials,
    });
    if (!entry) return { ok: false, error: createMessage('permissions.allowance.error.programNotFound', { program: program.path }) };
    // An id the contract does not take would drop a credential quietly.
    if (entry.credentials.length !== credentials.credentials.length) {
      return { ok: false, error: createMessage('permissions.allowance.error.invalid') };
    }
    if (!grantsSomething(entry)) {
      return { ok: false, error: createMessage('permissions.allowance.error.empty') };
    }
    return { ok: true, entry, secrets: credentials.secrets };
  }

  const { match } = createProgramAllowanceMatcher({
    readAllowances,
    locate,
    realPath: realpathOrNull,
    // An allowance widens the sandbox; without one there is nothing to widen.
    sandboxSupported: platformSupports(platform, PLATFORM_CAPABILITIES.EXECUTION_SANDBOX),
    trustdApplies: platform === 'darwin',
  });

  return { resolveProgram, validateWritePath, prepareEntry, match, locate };
}

module.exports = { createProgramAllowances };
