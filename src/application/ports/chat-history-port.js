/**
 * Chat-history port (#981): the stored conversation, as the core's
 * conversation service reads and changes it. How a chat is kept — one file per
 * chat, an index, encryption, the folder it belongs to — is main's business
 * (`services/chat-history-service.js` over `services/chat-history-store.js`).
 *
 * A chat that is not stored yet has no row: `addCost` keeps its sum until the
 * chat's first save takes it along, `setTitle` writes nothing.
 */

/**
 * @typedef {import('../../shared/contracts/cost').SessionCost} SessionCost
 *
 * @typedef {Object} StoredChatMessage
 * @property {string} role
 * @property {unknown} [content]
 * @property {boolean} [isError]
 *
 * @typedef {Object} StoredChat
 * @property {string} id
 * @property {string} [title]  the chat's own title; empty or derived when it was never named
 * @property {StoredChatMessage[]} messages
 * @property {SessionCost|null} [cost]
 */

/**
 * @typedef {Object} ChatHistoryPort
 * @property {(chatId: string) => Promise<StoredChat|null>} load
 *   the chat with its messages; null when it is not stored or cannot be read
 * @property {(chatId: string, cost: unknown) => Promise<SessionCost|null>} addCost
 *   adds a turn's cost to the chat's sum and answers with the new sum
 * @property {(chatId: string, title: string) => Promise<boolean>} setTitle
 *   names a stored chat; false when there is none to name
 */

module.exports = {};
