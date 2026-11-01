/**
 * Knowledge-journal port (#1278): the agent's last changes to knowledge files,
 * with the version before each, so that *Settings › Knowledge* can undo one.
 * The previous versions live in the app's own storage, never in the folder.
 */

/**
 * @typedef {Object} KnowledgeJournalEntry
 * @property {string} id
 * @property {string} at  ISO time
 * @property {string} source  `remember`, `file-tool` or `command`
 * @property {string} kind  `memory`, `rules`, `agents` or `skills`
 * @property {string} path  as shown: `<folder>/…` relative, `~/…` at home
 * @property {string} before  a short excerpt of the version before ('' for a new file)
 * @property {string} after  a short excerpt of the version after ('' for a removed file)
 */

/**
 * @typedef {Object} KnowledgeJournalPort
 * @property {(change: { file: string, path: string, kind: string, source: string, before: string|null, after: string|null }) => Promise<void>} record
 * @property {(files: string[]) => Promise<Map<string, string|null>>} capture  the files as they are, before a write
 * @property {(captured: Map<string, string|null>, change: { source: string, workspaceRoot: string|null }) => Promise<void>} commit
 *   records every captured file that the write changed
 * @property {() => Promise<KnowledgeJournalEntry[]>} list  newest first
 * @property {(id: string) => Promise<{ ok: boolean, reason?: string }>} undo
 */

module.exports = {};
