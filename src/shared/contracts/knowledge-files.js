/**
 * Knowledge files (#1319): the files Snotra embeds into every later
 * conversation — `AGENTS.md`, memory, rules files and skills. A write to one
 * outlives its run, so no tool writes one without a card the user answered,
 * in every permission mode (decision 6 of the knowledge concept,
 * `docs/concepts/memory-and-rules-concept.md`; threat model in
 * `docs/security/security-concept.md`, revision #1280).
 *
 * CommonJS, so that main (require) and renderer (generated ESM bundle) agree on
 * what counts.
 */
'use strict';

const { parseRuleFile } = require('./rules');

/** @typedef {typeof KNOWLEDGE_FILE_KINDS[keyof typeof KNOWLEDGE_FILE_KINDS]} KnowledgeFileKind */

const KNOWLEDGE_FILE_KINDS = Object.freeze({
  AGENTS: 'agents',
  MEMORY: 'memory',
  RULES: 'rules',
  SKILLS: 'skills',
});

/**
 * The kind of a path inside the open folder, given relative to it with `/`,
 * or null when it is no knowledge file. A folder itself counts too: writing
 * `.agents/rules` creates the place rules files live in.
 *
 * @param {unknown} relPath
 * @returns {KnowledgeFileKind|null}
 */
function workspaceKnowledgeKind(relPath) {
  if (typeof relPath !== 'string') return null;
  const rel = relPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (rel === 'AGENTS.md') return KNOWLEDGE_FILE_KINDS.AGENTS;
  if (rel === '.agents/memory.md') return KNOWLEDGE_FILE_KINDS.MEMORY;
  if (rel === '.agents/rules' || rel.startsWith('.agents/rules/')) return KNOWLEDGE_FILE_KINDS.RULES;
  if (rel === '.agents/skills' || rel.startsWith('.agents/skills/')) return KNOWLEDGE_FILE_KINDS.SKILLS;
  // The folder that holds them all: replacing or removing it replaces them.
  if (rel === '.agents') return KNOWLEDGE_FILE_KINDS.RULES;
  return null;
}

/**
 * The kind of a global knowledge path, given relative to the home folder
 * (`.snotra/memory.md`, `.agents/rules/x.md`), or null.
 *
 * @param {unknown} relPath
 * @returns {KnowledgeFileKind|null}
 */
function globalKnowledgeKind(relPath) {
  if (typeof relPath !== 'string') return null;
  const rel = relPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (rel === '.snotra/memory.md') return KNOWLEDGE_FILE_KINDS.MEMORY;
  if (rel === '.snotra/AGENTS.md' || rel === '.agents/AGENTS.md') return KNOWLEDGE_FILE_KINDS.AGENTS;
  for (const base of ['.snotra', '.agents']) {
    if (rel.startsWith(`${base}/rules/`)) return KNOWLEDGE_FILE_KINDS.RULES;
    if (rel.startsWith(`${base}/skills/`)) return KNOWLEDGE_FILE_KINDS.SKILLS;
  }
  return null;
}

/**
 * The knowledge paths of the global level, under the home folder: files and
 * folders no tool may write — only `remember` does, through its card.
 *
 * @param {{ join: (...parts: string[]) => string }} path
 * @param {string} home
 * @returns {string[]}
 */
function globalKnowledgePaths(path, home) {
  if (typeof home !== 'string' || !home) return [];
  return [
    path.join(home, '.snotra', 'memory.md'),
    path.join(home, '.snotra', 'AGENTS.md'),
    path.join(home, '.snotra', 'rules'),
    path.join(home, '.snotra', 'skills'),
    path.join(home, '.agents', 'AGENTS.md'),
    path.join(home, '.agents', 'rules'),
    path.join(home, '.agents', 'skills'),
  ];
}

/**
 * Whether a rules file a write would leave behind says `always: true` — the
 * card shows it, since such a rule goes along with every message.
 *
 * @param {unknown} content
 */
function writtenRuleIsAlways(content) {
  return parseRuleFile(content)?.always === true;
}

module.exports = {
  KNOWLEDGE_FILE_KINDS,
  workspaceKnowledgeKind,
  globalKnowledgeKind,
  globalKnowledgePaths,
  writtenRuleIsAlways,
};
