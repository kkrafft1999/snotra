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
  PROGRAM_ALLOWANCE_SKIP_REASONS,
  programName,
  normalizeAllowancePath,
  normalizeProgramAllowance,
  parseDomainInput,
  PROGRAM_ALLOWANCE_LIMITS,
} = require('../../shared/contracts/program-allowances');
const { parseSimpleCommand } = require('../../shared/runtime/simple-command');
const { createMessage } = require('../../shared/contracts/message');
const { quoteArgv } = require('./sandbox-service');

/**
 * @param {object} deps
 * @param {object} deps.fs      fs/promises
 * @param {object} deps.path
 * @param {object} deps.os
 * @param {string} [deps.platform]
 * @param {() => Promise<string>} [deps.readUserPath]  the PATH of the user's shell
 * @param {() => Promise<object[]>} [deps.readAllowances]  the stored allowances
 * @param {string[]} [deps.protectedRoots]  Snotra's own storage, never writable
 * @param {string[]} [deps.sensitivePaths]  what the sandbox keeps unreadable (`~` allowed)
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
}) {
  const X_OK = fs?.constants?.X_OK ?? 1;
  const home = os.homedir();

  function expandHome(value) {
    if (value === '~') return home;
    return value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  }

  async function realpathOrNull(target) {
    try {
      return await fs.realpath(target);
    } catch {
      return null;
    }
  }

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
   * @returns {Promise<{ok: true, path: string, name: string}|{ok: false, error: object}>}
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
   * @returns {Promise<{ok: true, path: string}|{ok: false, error: object}>}
   */
  async function validateWritePath(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    const absolute = normalizeAllowancePath(expandHome(text));
    if (!absolute) return { ok: false, error: createMessage('permissions.allowance.error.folderInvalid', { folder: text.slice(0, 200) }) };
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
   * The entry the settings dialog wants to store, checked the way main sees
   * the machine: program resolved, every domain a host name, every folder
   * allowed. trustd only exists on macOS.
   *
   * @returns {Promise<{ok: true, entry: object}|{ok: false, error: object}>}
   */
  async function prepareEntry(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
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
    const writePaths = [];
    for (const folder of folders) {
      const checked = await validateWritePath(folder);
      if (!checked.ok) return checked;
      writePaths.push(checked.path);
    }
    const entry = normalizeProgramAllowance({
      path: program.path,
      domains: parsed.domains,
      writePaths,
      trustd: platform === 'darwin' && data.trustd === true,
    });
    if (!entry) return { ok: false, error: createMessage('permissions.allowance.error.programNotFound', { program: program.path }) };
    if (entry.domains.length === 0 && entry.writePaths.length === 0 && !entry.trustd) {
      return { ok: false, error: createMessage('permissions.allowance.error.empty') };
    }
    return { ok: true, entry };
  }

  /** Program names an unreadable line mentions, for saying why nothing applies. */
  function mentionedPrograms(command, allowances) {
    const names = new Set();
    for (const token of String(command).split(/[\s;&|<>()`$"'=\\]+/)) {
      const name = programName(token);
      if (name) names.add(name);
    }
    return allowances.map((entry) => programName(entry.path)).filter((name) => names.has(name));
  }

  /**
   * The allowance a shell_execute call gets, or why the one naming its
   * program does not apply, or null when no allowance is concerned.
   *
   * @returns {Promise<null
   *   | {allowance: {path: string, program: string, domains: string[], writePaths: string[], trustd: boolean},
   *      command: string, entry: object}
   *   | {skipped: {program: string, reason: string}}>}
   */
  async function match({ command, cwd } = {}) {
    if (platform === 'win32') return null;
    const allowances = (await readAllowances().catch(() => []))
      .map(normalizeProgramAllowance)
      .filter(Boolean);
    if (allowances.length === 0 || typeof command !== 'string') return null;

    const parsed = parseSimpleCommand(command);
    if (!parsed.ok) {
      if (parsed.reason === 'empty') return null;
      const [program] = mentionedPrograms(command, allowances);
      if (!program) return null;
      const reason = parsed.reason === 'expansion'
        ? PROGRAM_ALLOWANCE_SKIP_REASONS.EXPANSION
        : PROGRAM_ALLOWANCE_SKIP_REASONS.COMPOUND;
      return { skipped: { program, reason } };
    }

    const [first] = parsed.words;
    const name = programName(first.value);
    const candidates = allowances.filter((entry) => programName(entry.path) === name);
    if (candidates.length === 0) return null;
    const located = await locate(first.value, cwd);
    const real = located ? await realpathOrNull(located) : null;
    for (const entry of candidates) {
      if (!real || real !== (await realpathOrNull(entry.path))) continue;
      return {
        allowance: {
          path: entry.path,
          program: name,
          domains: entry.domains,
          writePaths: entry.writePaths,
          trustd: platform === 'darwin' && entry.trustd,
        },
        command: `${quoteArgv([entry.path])}${command.slice(first.end)}`,
        // The stored entry as it was matched, so a later change is noticed.
        entry,
      };
    }
    return { skipped: { program: name, reason: PROGRAM_ALLOWANCE_SKIP_REASONS.OTHER_FILE } };
  }

  return { resolveProgram, validateWritePath, prepareEntry, match, locate };
}

module.exports = { createProgramAllowances };
