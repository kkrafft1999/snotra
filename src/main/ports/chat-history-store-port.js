/**
 * Chat-Verlauf-Persistenz.
 *
 * One file per chat and an index held in memory (#985). The list and the
 * chat's own settings come from the index and carry no messages; `getSession`
 * reads a chat's messages when it is opened. Changes made from IPC handlers
 * that read before they write run inside `withChatHistoryLock`; the store
 * itself orders its changes on its own and never waits for that lock.
 *
 * @typedef {import('../services/chat-history-normalization').StoredSession} StoredSession
 * @typedef {import('../services/chat-history-normalization').SessionMeta} SessionMeta
 * @typedef {import('../services/chat-history-normalization').SessionListRow} SessionListRow
 * @typedef {import('../services/chat-history-normalization').SessionRowInput} SessionRowInput
 * @typedef {import('../services/chat-history-normalization').SessionRow} SessionRow
 * @typedef {import('../services/chat-history-normalization').LoadedSession} LoadedSession
 *
 * @typedef {Object} ChatHistoryStorePort
 * @property {number} MAX_CHAT_SESSIONS
 * @property {() => Promise<SessionMeta[]>} listSessions Every chat's index entry, newest first, without messages
 * @property {(id: string) => Promise<SessionMeta|null>} getSessionMeta One chat's index entry
 * @property {(id: string) => Promise<StoredSession|null>} getSession The whole chat in store form; `null` when it is not there or cannot be read
 * @property {(bucketKey: string) => Promise<string|null>} getActiveChatId The chat a folder opens with
 * @property {(session: StoredSession) => Promise<{ droppedIds: string[] }>} saveSession Saves a chat in store form; returns the chats dropped beyond MAX_CHAT_SESSIONS
 * @property {(id: string, patch: Record<string, unknown>) => Promise<boolean>} patchSession Changes a chat's own settings (model, mode, level, overrides)
 * @property {(id: string) => Promise<void>} deleteSession
 * @property {(bucketKey: string, id: string|null) => Promise<boolean>} setActiveChatId Resolves to whether anything was written
 * @property {(fn: () => Promise<unknown>) => Promise<unknown>} withChatHistoryLock
 * @property {() => Promise<boolean>} hasSetAsideChatHistory A history moved aside (#565) lies next to the live one
 * @property {(existingMessages: unknown, nextMessages: unknown) => boolean} storedChatMessagesChanged
 * @property {(sessionRow: SessionRowInput|null|undefined, options?: { normalizeWorkspaceRoot?: (raw: unknown) => string|null, existingTitle?: string, requireMessages?: boolean }) => StoredSession|null} normalizeSessionForStore
 * @property {(sessionRow: SessionRow|null|undefined, options?: { toolCategoryOf?: ((toolName: string) => (string|null))|null }) => LoadedSession|null} normalizeSessionForLoad
 * @property {(meta: SessionMeta|null|undefined) => SessionListRow|null} normalizeSessionMetaForList A row of the history list
 * @property {(raw: unknown) => string|null} normalizeWorkspaceRoot
 * @property {(workspaceRoot: string|null) => string} workspaceBucketKey
 * @property {(sessionRow: { workspaceRoot?: string|null }, workspaceRoot: string|null) => boolean} sessionMatchesWorkspace
 */

module.exports = {};
