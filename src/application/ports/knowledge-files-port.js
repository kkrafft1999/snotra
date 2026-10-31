/**
 * Knowledge-files port (#1319): what the knowledge files of the open folder
 * held before a shell or Python command, what the command changed in them,
 * and the way back.
 *
 * A command may change `AGENTS.md` or `.agents/` legitimately — `git pull`,
 * `git checkout` — so it is not blocked; the engine takes a snapshot before
 * it, compares after it, and a card asks whether to keep the change.
 */

/**
 * @typedef {Object} KnowledgeSnapshot
 * @property {Map<string, string>} files  path relative to the folder → its text
 * @property {boolean} complete  false when a limit kept files out; those are not compared
 */

/**
 * @typedef {Object} KnowledgeChange
 * @property {string} path  relative to the folder, with `/`
 * @property {import('../../shared/contracts/knowledge-files').KnowledgeFileKind} kind
 * @property {'added'|'changed'|'removed'} status
 */

/**
 * @typedef {Object} KnowledgeFilesPort
 * @property {(options: { workspaceRoot: string }) => Promise<KnowledgeSnapshot>} snapshot
 * @property {(before: KnowledgeSnapshot, after: KnowledgeSnapshot) => { changes: KnowledgeChange[], diff: string, truncated: boolean }} compare
 * @property {(options: { workspaceRoot: string, before: KnowledgeSnapshot, changes: KnowledgeChange[] }) => Promise<{ ok: boolean, failed: string[] }>} restore
 *   writes back what a file held before, and removes one the command added
 */

module.exports = {};
