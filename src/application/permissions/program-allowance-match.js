'use strict';

/**
 * Whether a program allowance covers a command (#408, #1172): the rule a
 * second front end needs as it is. A command earns an allowance only when it
 * is one simple command whose program resolves to the same real file the
 * allowance names; the line that then runs starts with that file's absolute
 * path. Finding a program on the user's PATH and reading real paths is the
 * host's (`src/main/services/program-allowances-service.js`), handed in.
 */

const {
  PROGRAM_ALLOWANCE_SKIP_REASONS,
  programName,
  normalizeProgramAllowance,
} = require('../../shared/contracts/program-allowances');
const { parseSimpleCommand } = require('../../shared/runtime/simple-command');
const { quoteArgv } = require('../../shared/runtime/quote-argv');

/** @typedef {import('../../shared/contracts/program-allowances').ProgramAllowance} ProgramAllowance */

/**
 * @param {Object} deps
 * @param {(workspaceRoot: string|null) => Promise<unknown[]>} deps.readAllowances
 *   the allowances that apply in a workspace: its own and the global ones (#1119)
 * @param {(word: string, cwd: string|null|undefined) => Promise<string|null>} deps.locate
 *   the executable a command's first word names, through the user's PATH
 * @param {(target: string) => Promise<string|null>} deps.realPath  null when it does not resolve
 * @param {boolean} deps.sandboxSupported  whether this platform isolates commands at all
 * @param {boolean} deps.trustdApplies  whether an allowance can open trustd (macOS)
 */
function createProgramAllowanceMatcher({ readAllowances, locate, realPath, sandboxSupported, trustdApplies }) {
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
    const real = located ? await realPath(located) : null;
    for (const entry of candidates) {
      if (!real || real !== (await realPath(entry.path))) continue;
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
