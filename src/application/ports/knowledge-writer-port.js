/**
 * Knowledge-writer port (#1276): where `remember` puts a fact or a rule for a
 * reader, what the card shows about it beforehand, and the write itself. The
 * core does not know where the files lie; this port does.
 */

/**
 * @typedef {Object} KnowledgeWriteRequest
 * @property {string} kind  `fact` | `rule` | `instruction`
 * @property {string} scope  `user` | `workspace` | `team`
 * @property {string|null} [workspaceRoot]
 * @property {string} text  the entry, one thought
 * @property {string} [topic]  rule: the rules file's name
 * @property {string} [description]  rule: required for a new file, optional new one for an existing file
 * @property {boolean} [always]  rule, new file only
 * @property {string} origin  `requested` | `self`
 * @property {string} [replaces]  the exact text of an entry at the same level, removed after the write
 * @property {string} [replacesIn]  `memory` or a rules file's topic
 */

/**
 * @typedef {Object} KnowledgeTarget
 * @property {string} path  as the card shows it: `<folder>/…` relative, `~/…` at home
 * @property {boolean} exists
 * @property {'memory'|'rules'|'agents'} file
 */

/**
 * @typedef {Object} KnowledgeDescription
 * @property {KnowledgeTarget|null} target  null when the request cannot be written (see `refusal`)
 * @property {string} [refusal]  why nothing would be written
 * @property {{ description: string, always: boolean }} [ruleFile]  the existing rules file
 * @property {{ text: string, where: string, count: number }} [replaced]  the entry `replaces` would remove
 * @property {Record<string, Record<string, KnowledgeTarget|null>>} alternatives  the target per kind and reader
 * @property {{ agentsMd: boolean, rulesFiles: number }} folderInstructions  what the open folder brings
 */

/**
 * @typedef {Object} KnowledgeWriterPort
 * @property {(request: KnowledgeWriteRequest) => Promise<KnowledgeDescription>} describe
 * @property {(request: KnowledgeWriteRequest) => Promise<{ kind: string, scope: string, file: string, text: string,
 *   replaced?: { removed: number, error?: string } }>} write
 */

module.exports = {};
