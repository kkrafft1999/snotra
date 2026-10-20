/**
 * RemoteDesktop port (#1194): what the remote dispatcher reads of the
 * desktop for step 1 of `docs/remote-interface.md` §10 — the known
 * workspaces, the one that is open, the stored chats, which of them run, and
 * the events of a running turn by chat.
 *
 * Read only. Paths cross this port, since the release list is kept by root;
 * they stop at the dispatcher, which hands out ids (§7.5). Nothing here
 * changes the chat on the desktop's screen.
 */

/**
 * A chat as the history's list keeps it.
 * @typedef {Object} RemoteChatRow
 * @property {string} chatId
 * @property {string|null} root
 * @property {string | import('../../shared/contracts/message').Message} title  a descriptor for a chat without a title
 * @property {number} updatedAt  ms
 * @property {number} messageCount
 */

/**
 * A stored chat with its messages, as the window loads it: tool lines
 * already worded in the desktop's language.
 * @typedef {Object} RemoteStoredChat
 * @property {string} chatId
 * @property {string|null} root
 * @property {string | import('../../shared/contracts/message').Message} title
 * @property {number} updatedAt
 * @property {Array<Record<string, unknown>>} messages
 */

/**
 * What happened on the desktop that a remote front end may have to hear of:
 * an event of a running turn — `delta`, `tool-line` or `progress`, the
 * payload as the window gets it — or a switch of the open workspace.
 * @typedef {{ kind: 'run', chatId: string, runId: string|null, type: string, payload: Record<string, unknown> }
 *   | { kind: 'workspace' }} RemoteDesktopActivity
 */

/**
 * @typedef {Object} RemoteDesktopPort
 * @property {() => Promise<string[]>} knownWorkspaces  the folders the desktop knows and that still exist
 * @property {() => string|null} activeWorkspace
 * @property {(roots: string[]) => Promise<RemoteChatRow[]>} listChats  the chats kept under these folders
 * @property {(chatId: string) => Promise<RemoteStoredChat|null>} loadChat  in whichever folder it is kept
 * @property {() => ReadonlySet<string>} runningChats  the ids of the chats whose turn is under way
 * @property {() => ReadonlySet<string>} awaitingApproval  the ids of the chats with a card open
 * @property {(listener: (activity: RemoteDesktopActivity) => void) => () => void} subscribe
 */

module.exports = {};
