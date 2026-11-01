'use strict';

/**
 * Rules port (#1275): reads the rules files of the three sources, in skill
 * order — `<folder>/.agents/rules/`, `~/.snotra/rules/`, `~/.agents/rules/`.
 *
 * Like `AGENTS.md` and the memory files, without a cache: a few small files
 * per request cost nothing against a model call, and a changed rule applies
 * from the next message on. The folder's files are contained like those of
 * #534 — a symlink out of the folder is treated as absent — and read no
 * further than their limit. The global ones are the user's own and may be
 * linked elsewhere by a dotfiles manager.
 */

const {
  RULES_DIR,
  RULE_SOURCES,
  RULE_SOURCE_LEVELS,
  RULE_LIMITS,
  ruleNameOfFile,
  parseRuleFile,
  normalizeRuleFiles,
  isRuleLevel,
  isValidRuleName,
} = require('../../shared/contracts/rules');
const { createEmbeddedTextFiles } = require('../services/embedded-text-file');

/** Room for the front matter on top of the body limit. */
const FRONTMATTER_ROOM = 2_000;

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {typeof import('os')} deps.os
 * @returns {import('../../application/ports/rules-port').RulesPort}
 */
function createRulesAdapter({ fs, path, os }) {
  if (!fs || !path) throw new TypeError('createRulesAdapter needs fs and path.');
  const textFiles = createEmbeddedTextFiles({ fs, path });

  function homeDir() {
    try {
      const home = os && typeof os.homedir === 'function' ? os.homedir() : null;
      return typeof home === 'string' && home.trim() ? path.resolve(home) : null;
    } catch {
      // No home folder to read from: only the folder's rules, then.
      return null;
    }
  }

  /**
   * The folders in reading order, each with the root its files must stay in.
   *
   * @param {unknown} workspaceRoot
   * @returns {Array<{ source: import('../../shared/contracts/rules').RuleSource, dir: string, root: string|null }>}
   */
  function chain(workspaceRoot) {
    const targets = [];
    const root = typeof workspaceRoot === 'string' && workspaceRoot.trim() ? path.resolve(workspaceRoot) : null;
    if (root) targets.push({ source: RULE_SOURCES.WORKSPACE, dir: path.join(root, '.agents', RULES_DIR), root });
    const home = homeDir();
    if (home) {
      targets.push({ source: RULE_SOURCES.USER_SNOTRA, dir: path.join(home, '.snotra', RULES_DIR), root: null });
      targets.push({ source: RULE_SOURCES.USER_AGENTS, dir: path.join(home, '.agents', RULES_DIR), root: null });
    }
    // Opening `~/.snotra` or `~/.agents` itself makes the folder's rules and the
    // global ones the same folder; the first hit stays, as with AGENTS.md.
    const seen = new Set();
    return targets.filter(({ dir }) => (seen.has(dir) ? false : (seen.add(dir), true)));
  }

  /** @param {string} dir */
  async function entriesOf(dir) {
    try {
      return await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // A folder that is not there is the normal case, not an error.
      return [];
    }
  }

  /**
   * One rules file, read for the prompt; null when it is absent, empty or leads out.
   *
   * @param {{ source: import('../../shared/contracts/rules').RuleSource, dir: string, root: string|null }} target
   * @param {string} name
   */
  async function readRule({ source, dir, root }, name) {
    const file = path.join(dir, `${name}.md`);
    const read = await textFiles.readForPrompt({ file, root, maxChars: RULE_LIMITS.BODY_CHARS + FRONTMATTER_ROOM });
    if (!read) return null;
    const parsed = parseRuleFile(read.text);
    if (!parsed) return null;
    const cut = parsed.body.length > RULE_LIMITS.BODY_CHARS;
    let mtimeMs;
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch {
      // Without its age the file simply sorts first among the `always` rules.
      mtimeMs = undefined;
    }
    return {
      source,
      level: RULE_SOURCE_LEVELS[source],
      name,
      description: parsed.description,
      descriptionDerived: parsed.descriptionDerived,
      always: parsed.always,
      body: cut ? parsed.body.slice(0, RULE_LIMITS.BODY_CHARS) : parsed.body,
      truncated: cut || read.truncated,
      mtimeMs,
    };
  }

  /** @param {{ dir: string }} target */
  async function countInSubfolders({ dir }) {
    let count = 0;
    for (const entry of await entriesOf(dir)) {
      if (!entry.isDirectory()) continue;
      for (const inner of await entriesOf(path.join(dir, entry.name))) {
        if (inner.isFile() && inner.name.endsWith('.md')) count += 1;
      }
    }
    return count;
  }

  return {
    async load({ workspaceRoot = null } = {}) {
      /** @type {Array<Record<string, unknown>>} */
      const files = [];
      /** @type {Record<string, number>} */
      const inSubfolders = {};
      /** @type {Record<string, number>} */
      const overLimit = {};
      /** `.md` files whose name is no rule name: listed in the settings as invalid (#1278). */
      /** @type {Array<{ source: string, file: string }>} */
      const invalid = [];
      /** Names already taken at the user level: `~/.snotra` shadows `~/.agents`. */
      const userNames = new Set();
      for (const target of chain(workspaceRoot)) {
        const entries = (await entriesOf(target.dir)).filter((entry) => entry.isFile() || entry.isSymbolicLink());
        for (const entry of entries) {
          if (entry.name.endsWith('.md') && ruleNameOfFile(entry.name) === null) invalid.push({ source: target.source, file: entry.name });
        }
        const names = entries
          .map((entry) => ruleNameOfFile(entry.name))
          .filter((name) => name !== null)
          .sort();
        if (names.length > RULE_LIMITS.FILES_PER_SOURCE) overLimit[target.source] = names.length - RULE_LIMITS.FILES_PER_SOURCE;
        const read = await Promise.all(names.slice(0, RULE_LIMITS.FILES_PER_SOURCE).map((name) => readRule(target, name)));
        for (const rule of read) {
          if (!rule) continue;
          if (rule.level === 'user') {
            if (userNames.has(rule.name)) {
              files.push({ ...rule, shadowed: true });
              continue;
            }
            userNames.add(rule.name);
          }
          files.push(rule);
        }
        const nested = await countInSubfolders(target);
        if (nested) inSubfolders[target.source] = nested;
      }
      return { files: normalizeRuleFiles(files), inSubfolders, overLimit, invalid };
    },

    /** Where the rules files of a source lie, for *Open* and *New rules file* (#1278). */
    dirOf({ workspaceRoot = null, source }) {
      return chain(workspaceRoot).find((target) => target.source === source)?.dir ?? null;
    },

    async loadRule({ workspaceRoot = null, name, level }) {
      if (!isValidRuleName(name) || !isRuleLevel(level)) return null;
      for (const target of chain(workspaceRoot)) {
        if (RULE_SOURCE_LEVELS[target.source] !== level) continue;
        const rule = await readRule(target, name);
        if (rule) return normalizeRuleFiles([rule])[0] ?? null;
      }
      return null;
    },
  };
}

module.exports = {
  createRulesAdapter,
};
