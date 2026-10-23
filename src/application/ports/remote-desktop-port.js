/**
 * RemoteDesktop port (#1194): what the remote dispatcher reads of the
 * desktop for step 1 of `docs/remote-interface.md` §10 — the known
 * workspaces, the one that is open, the stored chats, which of them run, and
 * the events of a running turn by chat — and, for step 2, what it asks the
 * desktop to do: run a turn, stop one, describe a chat's configuration.
 *
 * Paths cross this port, since the release list is kept by root; they stop
 * at the dispatcher, which hands out ids (§7.5). Nothing here changes the
 * chat on the desktop's screen: a turn runs with its own chat's model, mode
 * and level (§7.3).
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
 * payload as the window gets it —, a switch of the open workspace, or a card
 * that went out or was settled (step 3), the card as the window's DTO.
 * @typedef {{ kind: 'run', chatId: string, runId: string|null, type: string, payload: Record<string, unknown> }
 *   | { kind: 'workspace' }
 *   | { kind: 'approval', type: 'request', chatId: string|null, dto: Record<string, unknown> }
 *   | { kind: 'approval', type: 'resolved', requestId: string, chatId: string|null, response: string|null,
 *       invalidated: boolean, reason: string|null, by: { kind: string, client?: string } | null }} RemoteDesktopActivity
 */

/**
 * @typedef {Object} RemoteDesktopPort
 * @property {() => Promise<string[]>} knownWorkspaces  the folders the desktop knows and that still exist
 * @property {() => string|null} activeWorkspace
 * @property {(roots: string[]) => Promise<RemoteChatRow[]>} listChats  the chats kept under these folders
 * @property {(chatId: string) => Promise<RemoteStoredChat|null>} loadChat  in whichever folder it is kept
 * @property {() => ReadonlySet<string>} runningChats  the ids of the chats whose turn is under way
 * @property {() => ReadonlySet<string>} awaitingApproval  the ids of the chats with a card open
 * @property {() => Array<Record<string, unknown>>} pendingApprovals  the open cards, as the window's DTOs
 * @property {(requestId: unknown, answer: { response?: unknown, sandboxPaths?: unknown }, by: { kind: string, client?: string }) =>
 *   { ok: true, response: string } | { ok: false, reason: 'not-found' | 'refused' }} respondToApproval
 *   only *allow once* or *deny*, and on a sandbox card only paths it offered (§7.4)
 * @property {(listener: (activity: RemoteDesktopActivity) => void) => () => void} subscribe
 * @property {(turn: RemoteTurn) => Promise<{ ok: true } | { ok: false, reason: 'unavailable' }>} startTurn
 *   starts a turn in the open workspace and answers once it is accepted; its events, and a
 *   `run-end` after its last one, arrive through `subscribe` under `turn.runId`
 * @property {(chatId: string) => boolean} stopChat  stops the chat's turn, whoever started it; false when none ran
 * @property {(chatId: string, root: string) => Promise<RemoteChatConfiguration>} chatConfiguration
 * @property {(root: string) => Promise<{ ok: true } | { ok: false, reason: 'unsaved' | 'refused' | 'no-answer' }>} activateWorkspace
 *   opens a known folder at the desktop, through the window when there is one, and tells
 *   whoever sits there (step 2c); `unsaved` when the file on show has unsaved changes
 */

/**
 * A turn a remote front end asks for (§8.1 `message.send`): the text only,
 * never a history, a path or a model.
 * @typedef {Object} RemoteTurn
 * @property {string} connectionId  the front end's connection, which the turn is kept under
 * @property {string} chatId
 * @property {string} text
 * @property {string} runId
 * @property {{ kind: string, client: string }} [origin]  the front end's kind and name, kept with the question (#1197)
 */

/**
 * What a chat runs with (§8.1 `chat.configuration`), read only.
 * @typedef {Object} RemoteChatConfiguration
 * @property {{ label: string }} model
 * @property {string} mode
 * @property {string|null} reasoning
 * @property {Array<{ name: string, state: string }>} skills
 * @property {Array<{ name: string, on: boolean }>} tools
 */

module.exports = {};
