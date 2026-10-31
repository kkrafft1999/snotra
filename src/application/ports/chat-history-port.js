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
 * @typedef {Object} StoredAttachment
 * @property {string} [file]        where the history keeps the image
 * @property {string} [mediaType]
 * @property {string} [dataBase64]  the image itself, when it is at hand
 * @property {string} [name]
 *
 * @typedef {Object} StoredChatMessage
 * @property {string} role
 * @property {unknown} [content]
 * @property {boolean} [isError]
 * @property {StoredAttachment[]} [attachments]
 * @property {{ kind: string, client: string }} [origin]  a question a remote front end wrote (#1197)
 *
 * @typedef {Object} StoredChat
 * @property {string} id
 * @property {string} [title]  the chat's own title; empty or derived when it was never named
 * @property {StoredChatMessage[]} messages
 * @property {SessionCost|null} [cost]
 * @property {import('../../shared/contracts/task-kind').TaskKind} [taskKind]  its kind of task (#1281); none while unclassified
 * @property {string|null} [workspaceRoot]  the folder the chat is kept under; null for none
 * @property {unknown} [tokenUsage]         the usage of its last round
 *
 * @typedef {Object} ChatToSave
 * @property {string} id
 * @property {Array<Record<string, unknown>>} messages  in store form; a message still `streaming` is kept as cut off
 * @property {string|null} [workspaceRoot]  as `load` gave it; left out for a chat not stored yet
 * @property {unknown} [tokenUsage]
 */

/**
 * @typedef {Object} ChatHistoryPort
 * @property {(chatId: string) => Promise<StoredChat|null>} load
 *   the chat with its messages; null when it is not stored or cannot be read
 * @property {(chatId: string, cost: unknown) => Promise<SessionCost|null>} addCost
 *   adds a turn's cost to the chat's sum and answers with the new sum
 * @property {(chatId: string, title: string) => Promise<boolean>} setTitle
 *   names a stored chat; false when there is none to name
 * @property {(chatId: string, kind: { id: string, source: import('../../shared/contracts/task-kind').TaskKindSource }) => Promise<import('../../shared/contracts/task-kind').TaskKind|null>} setTaskKind
 *   gives a stored chat its kind of task (#1281), unless the one it has outranks the source;
 *   the kind written, or null when nothing was
 * @property {(chat: ChatToSave, options?: { markActive?: boolean }) => Promise<{ ok: boolean, unreadable?: boolean }>} save
 *   writes the chat's messages; `markActive` makes it the one its folder opens with. A chat
 *   deleted in this run of the app is not written again
 * @property {(chatId: string, file: string) => Promise<{ ok: boolean, mediaType?: string, dataBase64?: string }>} readAttachment
 *   an image of the chat, as the history keeps it
 */

module.exports = {};
