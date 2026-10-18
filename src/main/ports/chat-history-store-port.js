/**
 * Chat-Verlauf-Persistenz.
 *
 * One file per chat and an index held in memory (#985). The list and the
 * chat's own settings come from the index and carry no messages; `getSession`
 * reads a chat's messages when it is opened. Changes made from IPC handlers
 * that read before they write run inside `withChatHistoryLock`; the store
 * itself orders its changes on its own and never waits for that lock.
 *
 * @typedef {Object} ChatHistoryStorePort
 * @property {number} MAX_CHAT_SESSIONS
 * @property {() => Promise<object[]>} listSessions Every chat's index entry, newest first, without messages
 * @property {(id: string) => Promise<object|null>} getSessionMeta One chat's index entry
 * @property {(id: string) => Promise<object|null>} getSession The whole chat in store form; `null` when it is not there or cannot be read
 * @property {(bucketKey: string) => Promise<string|null>} getActiveChatId The chat a folder opens with
 * @property {(session: object) => Promise<{ droppedIds: string[] }>} saveSession Saves a chat in store form; returns the chats dropped beyond MAX_CHAT_SESSIONS
 * @property {(id: string, patch: object) => Promise<boolean>} patchSession Changes a chat's own settings (model, mode, level, overrides)
 * @property {(id: string) => Promise<void>} deleteSession
 * @property {(bucketKey: string, id: string|null) => Promise<boolean>} setActiveChatId Resolves to whether anything was written
 * @property {(fn: () => Promise<unknown>) => Promise<unknown>} withChatHistoryLock
 * @property {() => Promise<boolean>} hasSetAsideChatHistory A history moved aside (#565) lies next to the live one
 * @property {(existingMessages: unknown, nextMessages: object[]) => boolean} storedChatMessagesChanged
 * @property {(sessionRow: object, options?: object) => object|null} normalizeSessionForStore
 * @property {(sessionRow: object) => object|null} normalizeSessionForLoad
 * @property {(meta: object) => object|null} normalizeSessionMetaForList A row of the history list
 * @property {(raw: unknown) => string|null} normalizeWorkspaceRoot
 * @property {(workspaceRoot: string|null) => string} workspaceBucketKey
 * @property {(sessionRow: object, workspaceRoot: string|null) => boolean} sessionMatchesWorkspace
 */

module.exports = {};
