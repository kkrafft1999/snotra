'use strict';

/**
 * Whether a program allowance covers a command (#408, #1172): the rule a
 * second front end needs as it is. A command earns an allowance only when it
 * is one simple command whose program resolves to the same real file the
 * allowance names; the line that then runs starts with that file's absolute
 * path. Finding a program on the user's PATH and reading real paths is the
 * host's (`src/main/services/program-allowances-service.js`), handed in.
 *
 * The line may end in redirections of the program's output (#1379), so a
 * large output can go straight into a file instead of through the
 * conversation. Every file target must lie inside the open folder, where any
 * sandboxed command may write anyway, or be `/dev/null`; a target outside it
 * — an allowance's own write folders among them — keeps the allowance off.
 * So does a file target when the allowance hands over credentials: the
 * output is masked on its way to the model, a file would keep the secret.
 */

const {
  PROGRAM_ALLOWANCE_SKIP_REASONS,
  programName,
  normalizeProgramAllowance,
} = require('../../shared/contracts/program-allowances');
const { parseSimpleCommand } = require('../../shared/runtime/simple-command');
const { quoteArgv } = require('../../shared/runtime/quote-argv');

/** @typedef {import('../../shared/contracts/program-allowances').ProgramAllowance} ProgramAllowance */
/** @typedef {import('../../shared/runtime/simple-command').Redirection} Redirection */

/** Discards what is written to it; no file of the open folder needed. */
const DEV_NULL = '/dev/null';

/**
 * @param {Object} deps
 * @param {(workspaceRoot: string|null) => Promise<unknown[]>} deps.readAllowances
 *   the allowances that apply in a workspace: its own and the global ones (#1119)
 * @param {(word: string, cwd: string|null|undefined) => Promise<string|null>} deps.locate
 *   the executable a command's first word names, through the user's PATH
 * @param {(target: string) => Promise<string|null>} deps.realPath  null when it does not resolve
 * @param {(target: string, cwd: string|null|undefined, workspaceRoot: string|null|undefined) => Promise<boolean>} [deps.isFileInFolder]
 *   whether a redirection target is a file inside the open folder, by its real
 *   path (#1379); without it no file target is accepted
 * @param {boolean} deps.sandboxSupported  whether this platform isolates commands at all
 * @param {boolean} deps.trustdApplies  whether an allowance can open trustd (macOS)
 */
function createProgramAllowanceMatcher({
  readAllowances, locate, realPath, isFileInFolder = async () => false, sandboxSupported, trustdApplies,
}) {
  /**
   * Program names an unreadable line mentions, for saying why nothing applies.
   *
   * @param {string} command
   * @param {ProgramAllowance[]} allowances
   */
  function mentionedPrograms(command, allowances) {
    /** @type {Set<string>} */
    const names = new Set();
    for (const token of String(command).split(/[\s;&|<>()`$"'=\\]+/)) {
      const name = programName(token);
      if (name) names.add(name);
    }
    return allowances.map((entry) => programName(entry.path)).filter((name) => names.has(name));
  }

  /**
   * Why the line's redirections keep an allowance off, or null (#1379).
   *
   * @param {Redirection[]} redirections
   * @param {ProgramAllowance} entry
   * @param {string|null|undefined} cwd
   * @param {string|null} workspaceRoot
   */
  async function refusedRedirection(redirections, entry, cwd, workspaceRoot) {
    /** @type {string[]} */
    const files = [];
    for (const redirection of redirections) {
      if ('target' in redirection && redirection.target !== DEV_NULL) files.push(redirection.target);
    }
    if (files.length === 0) return null;
    if (entry.credentials.length > 0) return PROGRAM_ALLOWANCE_SKIP_REASONS.REDIRECT_SECRETS;
    for (const target of files) {
      if (!workspaceRoot || !(await isFileInFolder(target, cwd, workspaceRoot))) {
        return PROGRAM_ALLOWANCE_SKIP_REASONS.REDIRECT_OUTSIDE;
      }
    }
    return null;
  }

  /**
   * The allowance a shell_execute call gets, or why the one naming its
   * program does not apply, or null when no allowance is concerned.
   *
   * @param {{ command?: unknown, cwd?: string|null, workspaceRoot?: string|null }} [params]
   * @returns {Promise<null
   *   | {allowance: {path: string, program: string, domains: string[], writePaths: string[], trustd: boolean,
   *      credentials: Array<{name: string, id: string}>},
   *      command: string, entry: ProgramAllowance}
   *   | {skipped: {program: string, reason: string}}>}
   */
  async function match({ command, cwd, workspaceRoot = null } = {}) {
    if (!sandboxSupported) return null;
    const allowances = (await readAllowances(workspaceRoot || null).catch(() => /* unreadable allowances grant nothing */ []))
      .map(normalizeProgramAllowance)
      .filter((entry) => entry !== null);
    if (allowances.length === 0 || typeof command !== 'string') return null;

    const parsed = parseSimpleCommand(command, { redirections: true });
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
    const real = located ? await realPath(located) : null;
    for (const entry of candidates) {
      if (!real || real !== (await realPath(entry.path))) continue;
      const refused = await refusedRedirection(parsed.redirections || [], entry, cwd, workspaceRoot);
      if (refused) return { skipped: { program: name, reason: refused } };
      return {
        allowance: {
          path: entry.path,
          program: name,
          domains: entry.domains,
          writePaths: entry.writePaths,
          trustd: trustdApplies && entry.trustd,
          // Names and ids only (#1262): the values stay in main's store and
          // are read for the run, if the plan still names these ids then.
          credentials: entry.credentials.map(({ name, id }) => ({ name, id })),
        },
        command: `${quoteArgv([entry.path])}${command.slice(first.end)}`,
        // The stored entry as it was matched, so a later change is noticed.
        entry,
      };
    }
    return { skipped: { program: name, reason: PROGRAM_ALLOWANCE_SKIP_REASONS.OTHER_FILE } };
  }

  return { match };
}

module.exports = { createProgramAllowanceMatcher };
