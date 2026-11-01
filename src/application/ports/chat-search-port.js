/**
 * Chat-search port (#1315): the earlier chats of the open workspace, as the
 * tool `search_chats` reads them. Chats are the episodic memory (knowledge
 * concept, *Episodes*): what happened when, and how a piece of work went.
 *
 * Behind the port sit the rules the tool relies on and cannot check itself:
 *
 * - only the chats of `workspaceRoot` — with no folder open, the chats
 *   without one — never those of another folder;
 * - never the asking chat itself;
 * - a local chat (decision 13) only for a turn that is local itself; for any
 *   other it does not exist, and nothing in the answer counts what was left out.
 *
 * Every answer goes to the model as JSON; an `error` field says why there is
 * no result.
 *
 * @typedef {Object} ChatSearchScope
 * @property {string|null} workspaceRoot  the run's folder; null while none is open
 * @property {string|null} chatId  the asking chat, which is never part of an answer
 * @property {boolean} runsLocally  whether the asking turn's model runs on this computer
 *
 * @typedef {Object} ChatSearchPort
 * @property {(request: ChatSearchScope & { query: unknown, limit?: unknown }) => Promise<unknown>} search
 *   the chats that contain every word, newest first, each with excerpts
 * @property {(request: ChatSearchScope & { chat: unknown, from?: unknown }) => Promise<unknown>} read
 *   the messages of one chat from a position on, within a size limit
 */

module.exports = {};
