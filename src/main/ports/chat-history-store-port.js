/**
 * Chat-Verlauf-Persistenz.
 *
 * @typedef {Object} ChatHistoryStorePort
 * @property {number} MAX_CHAT_SESSIONS
 * @property {(options?: { skipMigration?: boolean }) => Promise<object>} readChatHistoryStore
 * @property {(store: object) => Promise<void>} writeChatHistoryStore
 * @property {(fn: () => Promise<unknown>) => Promise<unknown>} withChatHistoryLock
 * @property {(sessionRow: object, options?: object) => object|null} normalizeSessionForStore
 * @property {(sessionRow: object) => object|null} normalizeSessionForLoad
 * @property {(raw: unknown) => string|null} normalizeWorkspaceRoot
 * @property {(workspaceRoot: string|null) => string} workspaceBucketKey
 * @property {(sessionRow: object, workspaceRoot: string|null) => boolean} sessionMatchesWorkspace
 */

/**
 * Error code of `writeChatHistoryStore` for a store that came from a failed
 * read (#473). The file is there and may be fine, so it is not overwritten
 * with the empty stand-in.
 */
const CHAT_HISTORY_UNREADABLE = 'CHAT_HISTORY_UNREADABLE';

module.exports = { CHAT_HISTORY_UNREADABLE };
