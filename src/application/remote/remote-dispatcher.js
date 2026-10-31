'use strict';

/**
 * The remote dispatcher (#1194): steps 1 and 2 of `docs/remote/remote-interface.md`
 * §10 — watching and writing. It stands behind the channel's message-layer
 * port, so that a request a connection sends after `session.hello` becomes a
 * call on the desktop, and what happens there becomes an event for the
 * connections that follow the chat.
 *
 * - **Methods** (§8.1): `workspaces.list`, `chats.list`, `chat.open`,
 *   `chat.more`, `chat.close` to watch; `chat.new`, `message.send`,
 *   `run.abort`, `chat.configuration`, `chat.setReasoning` to write — in a table per kind;
 *   anything else is `unknown-method`, a method the kind may not call
 *   `refused`. The channel answers `session.hello` and `session.bye` itself.
 * - **Writing** happens only in the workspace open at the desktop: a turn's
 *   tools work there, under its sandbox and rules, so a chat of another
 *   released workspace is `refused` until the desktop has switched (step 2c,
 *   `workspace.activate`). A turn runs with its own chat's model, mode and
 *   level (§7.3), and a repeated `clientMessageId` starts nothing.
 * - **Visibility** (§7.5): a connection sees the workspaces of the release
 *   list that the desktop still knows, by `workspaceId`, and only their
 *   chats. A chat outside them is `not-found`, exactly as an unknown one.
 *   No answer and no event carries a path.
 * - **Events** (§8.2): `session.welcome` and `state` when a connection
 *   opens, `state` again when it changes; `chat.delta`, `chat.tool-line` and
 *   `chat.progress` to the connections subscribed to their chat — deltas
 *   batched per chat when the transport asks for it (protocol §17);
 *   `chat.message` when a question another front end asked is saved,
 *   `chat.updated` when a chat got its name; `session.resync` when an event
 *   could not be delivered, and `session.closing` when the desktop ends the
 *   connections.
 *
 * - **Cards** (step 3, §7.4): a connection that declared `approvals` in
 *   `session.hello` gets the cards of the chats it follows
 *   (`approval.request`, `approval.resolved` naming who answered) and may
 *   answer them with *allow once* or *deny* — anything beyond is `refused`,
 *   not made smaller. The first valid answer wins, the window's included.
 *
 * Nothing here changes the chat on the desktop's screen.
 */

const { remoteRpcError } = require('../../shared/contracts/remote/rpc-errors');
const { isMessage } = require('../../shared/contracts/message');
const { isRecord } = require('../../shared/runtime/is-record');
const { normalizeReasoningLevel } = require('../../shared/contracts/reasoning');
const display = require('./remote-display');

/** What `session.hello` names as this message layer's limits (§8.1). */
/** The answers to a card a remote front end may give (§7.4): nothing that stores or widens. */
const APPROVAL_RESPONSES = Object.freeze(['allow-once', 'deny']);
const REQUEST_ID_MAX = 128;

const LIMITS = Object.freeze({
  maxRequestBytes: 256 * 1024,
  maxTextChars: 100_000,
  maxConnections: 1,
  eventBufferSeconds: 0,
});
const CHATS_DEFAULT = 50;
const CHATS_MAX = 200;
const MESSAGES_DEFAULT = 30;
const MESSAGES_MAX = 100;
/** How many chats one connection may follow at once. */
const SUBSCRIPTIONS_MAX = 32;
const CHAT_ID_MAX = 128;
const CURSOR_MAX = 256;
const CLIENT_MESSAGE_ID_MAX = 64;
/** How many `clientMessageId`s are remembered, and chats made by `chat.new` not written yet. */
const REMEMBERED_MAX = 500;

/** A request the dispatcher refuses, with the reason of §6.3 and, where it helps the client, `data.why`. */
class Refusal extends Error {
  /**
   * @param {Parameters<typeof remoteRpcError>[1]} reason
   * @param {Record<string, unknown>} [extra]
   */
  constructor(reason, extra = {}) {
    super(reason);
    this.reason = reason;
    this.extra = extra;
  }
}

/**
 * An optional integer between 1 and `max`; `fallback` when absent.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 */
function limitOf(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > max) throw new Refusal('invalid-params');
  return /** @type {number} */ (value);
}

/**
 * Keeps a map to its newest `max` entries.
 * @param {Map<unknown, unknown>} map
 * @param {number} max
 */
function trim(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

/** @param {unknown} value */
function chatIdOf(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > CHAT_ID_MAX) throw new Refusal('invalid-params');
  return value;
}

/**
 * The folder's own name, which is all of its path a remote is told.
 * @param {string} root
 */
function folderName(root) {
  return root.split(/[\\/]/).filter(Boolean).pop() || root;
}

/** @param {{ updatedAt: number, chatId: string }} row */
const cursorOf = (row) => Buffer.from(JSON.stringify([row.updatedAt, row.chatId])).toString('base64url');

/** @param {unknown} value */
function parseCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > CURSOR_MAX) throw new Refusal('invalid-params');
  try {
    const [updatedAt, chatId] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (Number.isFinite(updatedAt) && typeof chatId === 'string') return { updatedAt, chatId };
  } catch {
    // Falls through to the refusal: a cursor is only ever one this dispatcher made.
  }
  throw new Refusal('invalid-params');
}

/** Newest first, the id breaking a tie, so that pages do not overlap. */
const newestFirst = (/** @type {{ updatedAt: number, chatId: string }} */ a, /** @type {{ updatedAt: number, chatId: string }} */ b) => (
  b.updatedAt - a.updatedAt || (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0)
);

/**
 * @typedef {import('../ports/remote-message-layer-port').RemoteConnection} RemoteConnection
 *
 * @typedef {Object} Open  a connection that stands
 * @property {RemoteConnection} connection
 * @property {(event: object) => boolean} send
 * @property {Map<string, string>} subscriptions  chatId → the root it is kept under
 * @property {Map<string, { runId: string|null, text: string, timer: unknown }>} deltas  text not sent yet, by chat
 * @property {string|null} lastState  what `state` said last, to say it again only when it changed
 * @property {boolean} resyncing
 * @property {boolean} approvals  it declared the `approvals` capability: it is offered the cards of its chats
 * @property {boolean} knowledgeCards  it declared `knowledge-cards`: it shows a knowledge card in full (#1319)
 */

/**
 * @param {{
 *   desktop: import('../ports/remote-desktop-port').RemoteDesktopPort,
 *   releases: import('../ports/remote-release-port').RemoteReleasePort,
 *   word: (locale: string, message: import('../../shared/contracts/message').Message) => string,
 *   randomUUID?: () => string,
 *   deltaBatchMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `deltaBatchMs` the transport's batching of streamed text — 150 on the relay (protocol §17), 0 sends at once
 * @returns {import('../ports/remote-message-layer-port').RemoteMessageLayerPort & { closeAll: (reason: string) => void, answersCards: (chatId: string|null) => boolean }}
 */
function createRemoteDispatcher({
  desktop,
  releases,
  word,
  randomUUID = () => globalThis.crypto.randomUUID(),
  deltaBatchMs = 0,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(/** @type {any} */ (timer)),
  log = console,
}) {
  /** @type {Map<string, Open>} by connection id */
  const open = new Map();
  /** @type {Array<() => void>} */
  let unsubscribe = [];
  /**
   * Chats made by `chat.new` that no question has been saved in yet: id →
   * the root they will be kept under. Shared by every connection, so that a
   * client that reconnects can still write the first question.
   * @type {Map<string, string>}
   */
  const newChats = new Map();
  /**
   * What a `message.send` answered, by kind and `clientMessageId`, so that a
   * repeat answers again and starts nothing (§8.1) — also on a new connection.
   * @type {Map<string, { chatId: string, runId: string, messageId: string }>}
   */
  const sent = new Map();
  /**
   * The turns a remote front end started, by run: who started it, for the
   * mark on `chat.message`, until `run-end`.
   * @type {Map<string, { connectionId: string, kind: string, client: string }>}
   */
  const remoteRuns = new Map();
  /** @type {Set<string>} the chats whose turn a remote started and that have not ended yet */
  const startedChats = new Set();
  /** @type {Set<string>} chat and run whose question went out as `chat.message` */
  const announced = new Set();

  // ---------------------------------------------------------------- what a connection may see

  /** The released workspaces the desktop still knows: id ↔ root. */
  async function visible() {
    const [released, known] = await Promise.all([releases.list(), desktop.knownWorkspaces()]);
    const knownRoots = new Set(known);
    /** @type {Map<string, string>} */
    const byId = new Map();
    /** @type {Map<string, string>} */
    const byRoot = new Map();
    for (const { workspaceId, root } of released) {
      if (!knownRoots.has(root)) continue;
      byId.set(workspaceId, root);
      byRoot.set(root, workspaceId);
    }
    return { byId, byRoot };
  }

  /**
   * @param {string} chatId
   * @param {ReadonlySet<string>} running
   * @param {ReadonlySet<string>} awaiting
   */
  const chatState = (chatId, running, awaiting) => (awaiting.has(chatId) ? 'needs-approval' : running.has(chatId) ? 'running' : 'idle');

  /**
   * @param {RemoteConnection} connection
   * @param {unknown} title
   */
  const titleOf = (connection, title) => (isMessage(title) ? word(connection.locale, /** @type {any} */ (title)) : typeof title === 'string' ? title : '');

  /**
   * A chat the connection may see, with its messages; `not-found` otherwise.
   * @param {unknown} rawId
   */
  async function visibleChat(rawId) {
    const chatId = chatIdOf(rawId);
    const [chat, { byRoot }] = await Promise.all([desktop.loadChat(chatId), visible()]);
    if (!chat || chat.root === null || !byRoot.has(chat.root)) throw new Refusal('not-found');
    return chat;
  }

  /**
   * A chat the connection may write in: a visible one, or one `chat.new`
   * made, kept under a released workspace — and that workspace the one open
   * at the desktop, where the turn's tools work (§7.3, R6).
   * @param {unknown} rawId
   * @returns {Promise<{ chatId: string, root: string, messageCount: number }>}
   */
  async function writableChat(rawId) {
    const chatId = chatIdOf(rawId);
    const [chat, { byRoot }] = await Promise.all([desktop.loadChat(chatId), visible()]);
    const root = chat ? chat.root : newChats.get(chatId) ?? null;
    if (root === null || !byRoot.has(root)) throw new Refusal('not-found');
    if (root !== desktop.activeWorkspace()) throw new Refusal('refused');
    return { chatId, root, messageCount: chat ? chat.messages.length : 0 };
  }

  /**
   * A chat whose configuration the connection may read: a visible one, or one
   * `chat.new` made under a released workspace before its first question is
   * saved — it describes what the chat would start with.
   * @param {unknown} rawId
   * @returns {Promise<{ chatId: string, root: string }>}
   */
  async function describableChat(rawId) {
    const chatId = chatIdOf(rawId);
    const [chat, { byRoot }] = await Promise.all([desktop.loadChat(chatId), visible()]);
    const root = chat ? chat.root : newChats.get(chatId) ?? null;
    if (root === null || !byRoot.has(root)) throw new Refusal('not-found');
    return { chatId, root };
  }

  /** @param {string} chatId */
  const isBusy =(chatId) => startedChats.has(chatId) || desktop.runningChats().has(chatId) || desktop.awaitingApproval().has(chatId);

  // ---------------------------------------------------------------- events

  /**
   * @param {Open} entry
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  function emit(entry, method, params) {
    if (open.get(entry.connection.id) !== entry) return;
    if (entry.send({ jsonrpc: '2.0', method, params }) || entry.resyncing) return;
    // The transport could not carry it — over its limit, say — and the
    // client now misses part of a chat: it opens its chats again (§8.2).
    if (open.get(entry.connection.id) !== entry) return;
    entry.resyncing = true;
    entry.send({ jsonrpc: '2.0', method: 'session.resync', params: { reason: 'dropped' } });
    entry.resyncing = false;
  }

  /** `state` (§8.2) for every connection whose view of it changed. */
  async function pushState() {
    if (open.size === 0) return;
    const { byRoot } = await visible();
    const running = desktop.runningChats();
    const awaiting = desktop.awaitingApproval();
    const busyIds = new Set([...running, ...awaiting]);
    const rows = busyIds.size ? await desktop.listChats([...byRoot.keys()]) : [];
    const active = desktop.activeWorkspace();
    const params = {
      activeWorkspaceId: active !== null ? byRoot.get(active) ?? null : null,
      running: rows
        .filter((row) => busyIds.has(row.chatId) && row.root !== null && byRoot.has(row.root))
        .sort(newestFirst)
        .map((row) => ({ chatId: row.chatId, workspaceId: byRoot.get(/** @type {string} */ (row.root)), state: chatState(row.chatId, running, awaiting) })),
      // Of a workspace the connection may not see, no more than that the desktop is busy (§7.5).
      busy: running.size > 0,
    };
    const text = JSON.stringify(params);
    for (const entry of open.values()) {
      if (entry.lastState === text) continue;
      entry.lastState = text;
      emit(entry, 'state', params);
    }
  }

  function refreshState() {
    pushState().catch((error) => log.warn(`[remote] the state could not be read (${error?.name || 'error'})`));
  }

  /** Subscriptions to chats of a workspace no longer open to remotes end. */
  async function dropHidden() {
    const { byRoot } = await visible();
    for (const entry of open.values()) {
      for (const [chatId, root] of entry.subscriptions) {
        if (!byRoot.has(root)) unsubscribeChat(entry, chatId);
      }
    }
  }

  /**
   * @param {Open} entry
   * @param {string} chatId
   */
  function flushDelta(entry, chatId) {
    const pending = entry.deltas.get(chatId);
    if (!pending) return;
    entry.deltas.delete(chatId);
    if (pending.timer !== null) clearTimer(pending.timer);
    if (pending.text) emit(entry, 'chat.delta', { chatId, runId: pending.runId, text: pending.text });
  }

  /**
   * @param {Open} entry
   * @param {string} chatId
   */
  function unsubscribeChat(entry, chatId) {
    const pending = entry.deltas.get(chatId);
    if (pending?.timer != null) clearTimer(pending.timer);
    entry.deltas.delete(chatId);
    entry.subscriptions.delete(chatId);
  }

  /** @type {Set<string>} the chats whose turn this dispatcher has seen under way */
  const seenRunning = new Set();

  /**
   * @param {string} chatId
   * @param {string|null} runId
   */
  const runKey = (chatId, runId) => `${chatId}\u0000${runId ?? ''}`;

  /**
   * A turn's first save holds its question (#981): the connections that
   * follow the chat — all but the one that asked — get it as `chat.message`
   * (§8.2), with the mark of the front end that asked when it was a remote.
   * @param {string} chatId
   * @param {string|null} runId
   */
  function onSaved(chatId, runId) {
    newChats.delete(chatId);
    const key = runKey(chatId, runId);
    if (announced.has(key)) return;
    announced.add(key);
    const origin = runId !== null ? remoteRuns.get(runId) : undefined;
    const followers = () => [...open.values()].filter((entry) => entry.subscriptions.has(chatId) && entry.connection.id !== origin?.connectionId);
    if (followers().length === 0) return;
    desktop.loadChat(chatId).then((chat) => {
      const messages = chat ? chat.messages : [];
      let index = messages.length - 1;
      while (index >= 0 && messages[index]?.role !== 'user') index -= 1;
      if (index < 0) return;
      // The mark of a remote's question is stored with it (#1197).
      const message = display.displayMessage(messages[index], index);
      for (const entry of followers()) emit(entry, 'chat.message', { chatId, message });
    }).catch((error) => log.warn(`[remote] a question could not be read (${error?.name || 'error'})`));
  }

  /** @param {import('../ports/remote-desktop-port').RemoteDesktopActivity} activity */
  function onActivity(activity) {
    if (activity.kind === 'workspace') {
      refreshState();
      return;
    }
    if (activity.kind === 'approval') {
      onApproval(activity);
      return;
    }
    const { chatId, runId, type } = activity;
    const payload = isRecord(activity.payload) ? activity.payload : {};
    if (typeof chatId !== 'string' || !chatId) return;
    // What the conversation service says of the chat, not of the turn (#981).
    if (type === 'progress' && payload.type === 'chat-saved') {
      if (payload.ok === true) onSaved(chatId, runId);
      return;
    }
    if (type === 'progress' && payload.type === 'chat-named') {
      if (typeof payload.title === 'string' && payload.title) {
        for (const entry of open.values()) {
          if (entry.subscriptions.has(chatId)) emit(entry, 'chat.updated', { chatId, title: payload.title });
        }
      }
      return;
    }
    // A turn that starts or ends changes `state`.
    if (type === 'progress' && payload.type === 'run-end') {
      seenRunning.delete(chatId);
      announced.delete(runKey(chatId, runId));
      if (runId !== null && remoteRuns.delete(runId)) startedChats.delete(chatId);
      refreshState();
    } else if (!seenRunning.has(chatId)) {
      seenRunning.add(chatId);
      refreshState();
    }

    for (const entry of open.values()) {
      if (!entry.subscriptions.has(chatId)) continue;
      if (type === 'delta') {
        const textPart = typeof payload.text === 'string' ? payload.text : '';
        if (!textPart) continue;
        const pending = entry.deltas.get(chatId);
        if (pending && pending.runId === runId) {
          pending.text += textPart;
        } else {
          if (pending) flushDelta(entry, chatId);
          const next = { runId, text: textPart, timer: /** @type {unknown} */ (null) };
          entry.deltas.set(chatId, next);
          if (deltaBatchMs > 0) next.timer = setTimer(() => { next.timer = null; flushDelta(entry, chatId); }, deltaBatchMs);
        }
        if (deltaBatchMs <= 0) flushDelta(entry, chatId);
        continue;
      }
      // Whatever follows a delta comes after its text.
      flushDelta(entry, chatId);
      if (type === 'tool-line') {
        emit(entry, 'chat.tool-line', { chatId, runId, ...display.toolLineEvent(payload) });
      } else if (type === 'progress') {
        const event = display.progressEvent(payload);
        if (event) emit(entry, 'chat.progress', { chatId, runId, ...event });
      }
    }
  }

  /**
   * A card went out or was settled (§7.4): the connections that follow its
   * chat and take cards hear of it; `state` says the chat waits, or no more.
   * @param {Extract<import('../ports/remote-desktop-port').RemoteDesktopActivity, { kind: 'approval' }>} activity
   */
  function onApproval(activity) {
    refreshState();
    const { chatId } = activity;
    if (typeof chatId !== 'string' || !chatId) return;
    for (const entry of open.values()) {
      if (!entry.approvals || !entry.subscriptions.has(chatId)) continue;
      // What the card is about comes after the text streamed before it.
      flushDelta(entry, chatId);
      if (activity.type === 'request') {
        emit(entry, 'approval.request', cardFor(entry, activity.dto, /** @type {string} */ (entry.subscriptions.get(chatId))));
      } else {
        emit(entry, 'approval.resolved', {
          requestId: activity.requestId,
          chatId,
          response: activity.response,
          invalidated: activity.invalidated,
          reason: activity.reason,
          ...(activity.by ? { by: activity.by } : {}),
        });
      }
    }
  }

  /**
   * A card in the shape a connection sees it, with the answers it may give.
   * @param {Open} entry
   * @param {Record<string, unknown>} dto
   * @param {string|null} root
   */
  const cardFor = (entry, dto, root) => display.approvalRequest(dto, {
    root,
    word: (message) => word(entry.connection.locale, message),
    // A card about a knowledge file (#1319) is answered as proposed, and only
    // by a client that shows all of it; any other may only deny it.
    options: !entry.approvals ? [] : dto.knowledge === true && !entry.knowledgeCards ? ['deny'] : [...APPROVAL_RESPONSES],
  });

  /**
   * The open cards of a chat the connection may see.
   * @param {Open} entry
   * @param {string} chatId
   * @param {string} root
   */
  const cardsOf = (entry, chatId, root) => desktop.pendingApprovals()
    .filter((dto) => dto.chatId === chatId)
    .map((dto) => cardFor(entry, dto, root));

  function listen() {
    if (unsubscribe.length) return;
    unsubscribe = [
      desktop.subscribe(onActivity),
      releases.subscribe(() => {
        dropHidden().then(pushState).catch((error) => log.warn(`[remote] the release list could not be read (${error?.name || 'error'})`));
      }),
    ];
  }

  function stopListening() {
    for (const stop of unsubscribe) stop();
    unsubscribe = [];
    seenRunning.clear();
    announced.clear();
    // Their `run-end` is no longer heard; whether they still run, the desktop says.
    remoteRuns.clear();
    startedChats.clear();
  }

  // ---------------------------------------------------------------- methods

  /**
   * @typedef {(entry: Open, params: Record<string, unknown>) => Promise<Record<string, unknown>>} Method
   * @type {Record<string, { kinds: ReadonlyArray<string>, run: Method }>}
   */
  const METHODS = {
    'workspaces.list': {
      kinds: ['local', 'relay'],
      async run() {
        const { byRoot } = await visible();
        const active = desktop.activeWorkspace();
        return {
          workspaces: [...byRoot].map(([root, workspaceId]) => ({ workspaceId, name: folderName(root), active: root === active })),
        };
      },
    },

    'chats.list': {
      kinds: ['local', 'relay'],
      async run(entry, params) {
        const limit = limitOf(params.limit, CHATS_DEFAULT, CHATS_MAX);
        const before = parseCursor(params.before);
        const { byId, byRoot } = await visible();
        let roots = [...byRoot.keys()];
        if (params.workspaceId !== undefined) {
          const root = typeof params.workspaceId === 'string' ? byId.get(params.workspaceId) : undefined;
          if (root === undefined) throw new Refusal('not-found');
          roots = [root];
        }
        const running = desktop.runningChats();
        const awaiting = desktop.awaitingApproval();
        const rows = (await desktop.listChats(roots))
          .filter((row) => row.root !== null && roots.includes(row.root))
          .sort(newestFirst)
          .filter((row) => !before || newestFirst(row, before) > 0);
        const page = rows.slice(0, limit);
        return {
          chats: page.map((row) => ({
            chatId: row.chatId,
            title: titleOf(entry.connection, row.title),
            updatedAt: row.updatedAt,
            messageCount: row.messageCount,
            state: chatState(row.chatId, running, awaiting),
          })),
          ...(rows.length > limit ? { before: cursorOf(page[page.length - 1]) } : {}),
        };
      },
    },

    'chat.open': {
      kinds: ['local', 'relay'],
      async run(entry, params) {
        const limit = limitOf(params.limit, MESSAGES_DEFAULT, MESSAGES_MAX);
        const chat = await visibleChat(params.chatId);
        if (!entry.subscriptions.has(chat.chatId) && entry.subscriptions.size >= SUBSCRIPTIONS_MAX) throw new Refusal('busy');
        // Never `chatHistory:activate`: the chat on the desktop's screen stays (§8.1).
        entry.subscriptions.set(chat.chatId, /** @type {string} */ (chat.root));
        return {
          chatId: chat.chatId,
          title: titleOf(entry.connection, chat.title),
          state: chatState(chat.chatId, desktop.runningChats(), desktop.awaitingApproval()),
          ...display.messagePage(chat.messages, chat.messages.length, limit),
          pendingApprovals: entry.approvals ? cardsOf(entry, chat.chatId, /** @type {string} */ (chat.root)) : [],
        };
      },
    },

    'chat.more': {
      kinds: ['local', 'relay'],
      async run(_entry, params) {
        const limit = limitOf(params.limit, MESSAGES_DEFAULT, MESSAGES_MAX);
        const end = display.messageIndex(params.before);
        if (end === null) throw new Refusal('invalid-params');
        const chat = await visibleChat(params.chatId);
        return display.messagePage(chat.messages, end, limit);
      },
    },

    'chat.close': {
      kinds: ['local', 'relay'],
      async run(entry, params) {
        unsubscribeChat(entry, chatIdOf(params.chatId));
        return {};
      },
    },

    // ---- step 3: cards (§7.4) — allow once or deny, from a connection that takes them

    'approval.list': {
      kinds: ['local', 'relay'],
      async run(entry, params) {
        if (!entry.approvals) throw new Refusal('refused');
        const { byRoot } = await visible();
        if (params.chatId !== undefined) {
          const chat = await visibleChat(params.chatId);
          return { requests: cardsOf(entry, chat.chatId, /** @type {string} */ (chat.root)) };
        }
        const pending = desktop.pendingApprovals();
        const chatIds = [...new Set(pending.map((dto) => dto.chatId).filter((id) => typeof id === 'string'))];
        const roots = new Map((await Promise.all(chatIds.map((id) => desktop.loadChat(/** @type {string} */ (id)))))
          .filter((chat) => chat && chat.root !== null && byRoot.has(chat.root))
          .map((chat) => [/** @type {any} */ (chat).chatId, /** @type {any} */ (chat).root]));
        return {
          requests: pending.filter((dto) => roots.has(dto.chatId)).map((dto) => cardFor(entry, dto, roots.get(dto.chatId))),
        };
      },
    },

    'approval.respond': {
      kinds: ['local', 'relay'],
      async run(entry, params) {
        if (!entry.approvals) throw new Refusal('refused');
        const { requestId, response, sandboxPaths } = params;
        if (typeof requestId !== 'string' || !requestId || requestId.length > REQUEST_ID_MAX) throw new Refusal('invalid-params');
        if (typeof response !== 'string') throw new Refusal('invalid-params');
        if (sandboxPaths !== undefined && (!Array.isArray(sandboxPaths) || sandboxPaths.some((p) => p !== null && typeof p !== 'string'))) {
          throw new Refusal('invalid-params');
        }
        // Open, and of a chat this connection follows (§7.4): otherwise it is not this connection's card.
        const card = desktop.pendingApprovals().find((dto) => dto.requestId === requestId);
        const root = card && typeof card.chatId === 'string' ? entry.subscriptions.get(card.chatId) : undefined;
        if (!card || root === undefined) throw new Refusal('not-found');
        if (card.knowledge === true && !entry.knowledgeCards && response !== 'deny') throw new Refusal('refused');
        // A sandbox card's offers are named as the connection saw them: relative inside the workspace.
        const chosen = Array.isArray(sandboxPaths) ? sandboxPaths.map((p, i) => fromShown(card, i, p, root)) : undefined;
        const answered = desktop.respondToApproval(requestId, { response, sandboxPaths: chosen }, {
          kind: entry.connection.kind,
          client: entry.connection.client?.name || '',
        });
        if (!answered.ok) throw new Refusal(answered.reason);
        return { response: answered.response };
      },
    },

    // ---- step 2: writing (§8.1) — only in the workspace open at the desktop

    'workspace.activate': {
      kinds: ['local', 'relay'],
      async run(_entry, params) {
        const { workspaceId } = params;
        if (typeof workspaceId !== 'string' || !workspaceId) throw new Refusal('invalid-params');
        const root = (await visible()).byId.get(workspaceId);
        if (root === undefined) throw new Refusal('not-found');
        if (root === desktop.activeWorkspace()) return { workspaceId };
        // Not while a turn works or waits: its tools work in the open folder (R6).
        if (startedChats.size > 0 || desktop.runningChats().size > 0 || desktop.awaitingApproval().size > 0) {
          throw new Refusal('busy', { why: 'running' });
        }
        const switched = await desktop.activateWorkspace(root);
        if (switched.ok) return { workspaceId };
        if (switched.reason === 'unsaved') throw new Refusal('busy', { why: 'unsaved-changes' });
        if (switched.reason === 'refused') throw new Refusal('not-found');
        throw new Refusal('busy');
      },
    },

    'chat.new': {
      kinds: ['local', 'relay'],
      async run(_entry, params) {
        const { byId } = await visible();
        const active = desktop.activeWorkspace();
        let root = active;
        if (params.workspaceId !== undefined) {
          root = typeof params.workspaceId === 'string' ? byId.get(params.workspaceId) ?? null : null;
          if (root === null) throw new Refusal('not-found');
        } else if (active === null || ![...byId.values()].includes(active)) {
          throw new Refusal('not-found');
        }
        // A new chat is kept under the open workspace (#981): another one has to be switched to first.
        if (root !== active) throw new Refusal('refused');
        // Nothing is written yet: the chat exists once its first question is saved.
        const chatId = randomUUID();
        newChats.set(chatId, /** @type {string} */ (root));
        trim(newChats, REMEMBERED_MAX);
        return { chatId };
      },
    },

    'message.send': {
      kinds: ['local', 'relay'],
      async run(entry, params) {
        const { clientMessageId, text } = params;
        if (typeof clientMessageId !== 'string' || !clientMessageId || clientMessageId.length > CLIENT_MESSAGE_ID_MAX) throw new Refusal('invalid-params');
        if (typeof text !== 'string' || !text.trim()) throw new Refusal('invalid-params');
        if (text.length > LIMITS.maxTextChars) throw new Refusal('too-large');
        const key = `${entry.connection.kind}\u0000${clientMessageId}`;
        const before = sent.get(key);
        if (before) {
          // The same message again — a reply that got lost: answered as before, nothing starts.
          if (before.chatId !== params.chatId) throw new Refusal('invalid-params');
          return { runId: before.runId, messageId: before.messageId };
        }
        const chat = await writableChat(params.chatId);
        if (isBusy(chat.chatId)) throw new Refusal('busy');
        // The sender follows the chat it writes in, from the turn's first event
        // on — a chat from `chat.new` cannot be opened before its question is
        // saved (#1228). It counts like a subscription of `chat.open`.
        const subscribes = !entry.subscriptions.has(chat.chatId);
        if (subscribes && entry.subscriptions.size >= SUBSCRIPTIONS_MAX) throw new Refusal('busy');
        const runId = randomUUID();
        const answer = { runId, messageId: display.messageId(chat.messageCount) };
        // Known before the turn starts, so that a second send cannot slip in while it loads.
        startedChats.add(chat.chatId);
        remoteRuns.set(runId, { connectionId: entry.connection.id, kind: entry.connection.kind, client: entry.connection.client?.name || '' });
        if (subscribes) entry.subscriptions.set(chat.chatId, chat.root);
        const undo = () => {
          remoteRuns.delete(runId);
          startedChats.delete(chat.chatId);
          if (subscribes) unsubscribeChat(entry, chat.chatId);
        };
        let started;
        try {
          // The question keeps where it came from in the chat (#1197).
          const origin = { kind: entry.connection.kind, client: entry.connection.client?.name || '' };
          started = await desktop.startTurn({ connectionId: entry.connection.id, chatId: chat.chatId, text, runId, origin });
        } catch (error) {
          undo();
          throw error;
        }
        if (!started.ok) {
          undo();
          throw new Refusal('unavailable');
        }
        sent.set(key, { chatId: chat.chatId, ...answer });
        trim(sent, REMEMBERED_MAX);
        return answer;
      },
    },

    'run.abort': {
      kinds: ['local', 'relay'],
      async run(_entry, params) {
        const chatId = chatIdOf(params.chatId);
        // A chat outside what the connection sees is unknown to it, running or not (§7.5).
        if (!newChats.has(chatId)) await visibleChat(chatId);
        return { aborted: desktop.stopChat(chatId) };
      },
    },

    'chat.configuration': {
      kinds: ['local', 'relay'],
      async run(_entry, params) {
        const chat = await describableChat(params.chatId);
        const configuration = await desktop.chatConfiguration(chat.chatId, chat.root);
        return {
          model: { label: configuration.model.label },
          mode: configuration.mode,
          ...(configuration.reasoning ? { reasoning: configuration.reasoning } : {}),
          ...(configuration.reasoning && configuration.reasoningLevels.length > 0
            ? { reasoningLevels: [...configuration.reasoningLevels] }
            : {}),
          skills: configuration.skills,
          tools: configuration.tools,
        };
      },
    },

    // The one setting a connection may change (#1304): a reasoning level
    // grants nothing, it only changes a turn's depth and cost.
    'chat.setReasoning': {
      kinds: ['local', 'relay'],
      async run(_entry, params) {
        const chat = await describableChat(params.chatId);
        const level = normalizeReasoningLevel(params.level);
        if (!level || level !== params.level) throw new Refusal('invalid-params');
        const changed = await desktop.setReasoning(chat.chatId, level);
        if (!changed.ok) throw new Refusal('invalid-params');
        return { reasoning: changed.reasoning };
      },
    },
  };

  /**
   * The offer a sandbox card made at `index` whose shown form is `shown`, as
   * the card holds it; `shown` itself when none matches — the adapter then
   * refuses it.
   * @param {Record<string, unknown>} card
   * @param {number} index
   * @param {string|null} shown
   * @param {string} root
   */
  function fromShown(card, index, shown, root) {
    if (shown === null) return null;
    const entries = /** @type {any} */ (card.sandbox)?.entries;
    const allow = Array.isArray(entries) && Array.isArray(entries[index]?.allow) ? entries[index].allow : [];
    return allow.find((/** @type {unknown} */ offer) => display.inWorkspace(root, offer) === shown) ?? shown;
  }

  /** @param {RemoteConnection} connection */
  const methodsFor = (connection) => Object.keys(METHODS).filter((name) => METHODS[name].kinds.includes(connection.kind));

  // ---------------------------------------------------------------- the port

  return {
    describe: (connection) => ({
      methods: methodsFor(connection),
      approvalResponses: METHODS['approval.respond'].kinds.includes(connection.kind) ? [...APPROVAL_RESPONSES] : [],
      limits: { ...LIMITS },
    }),

    /**
     * Whether a connection that takes cards follows the chat: then a card of
     * the chat has someone to answer it even without a window (#1251).
     * @param {string|null} chatId
     */
    answersCards: (chatId) => typeof chatId === 'string'
      && [...open.values()].some((entry) => entry.approvals && entry.subscriptions.has(chatId)),

    open(connection, outlet) {
      /** @type {Open} */
      const entry = {
        connection,
        send: outlet.send,
        subscriptions: new Map(),
        deltas: new Map(),
        lastState: null,
        resyncing: false,
        approvals: Array.isArray(connection.capabilities) && connection.capabilities.includes('approvals'),
        knowledgeCards: Array.isArray(connection.capabilities) && connection.capabilities.includes('knowledge-cards'),
      };
      open.set(connection.id, entry);
      listen();
      emit(entry, 'session.welcome', { connectionId: connection.id, seq: 0 });
      refreshState();
    },

    async handle(connection, request) {
      const entry = open.get(connection.id);
      const wordIn = (/** @type {import('../../shared/contracts/message').Message} */ message) => word(connection.locale, message);
      if (!entry) return remoteRpcError(request.id, 'connection-unknown', wordIn);
      const method = Object.hasOwn(METHODS, request.method) ? METHODS[request.method] : null;
      if (!method) return remoteRpcError(request.id, 'unknown-method', wordIn);
      if (!method.kinds.includes(connection.kind)) return remoteRpcError(request.id, 'refused', wordIn);
      try {
        return { jsonrpc: '2.0', id: request.id, result: await method.run(entry, request.params) };
      } catch (error) {
        if (error instanceof Refusal) return remoteRpcError(request.id, error.reason, wordIn, error.extra);
        // Only the method and the kind of error: never what the request asked for.
        log.warn(`[remote] ${request.method} failed (${error?.name || 'error'})`);
        return remoteRpcError(request.id, 'internal', wordIn);
      }
    },

    close(connection) {
      const entry = open.get(connection.id);
      if (!entry) return;
      for (const chatId of [...entry.subscriptions.keys()]) unsubscribeChat(entry, chatId);
      open.delete(connection.id);
      if (open.size === 0) stopListening();
    },

    /** Tells every connection that the desktop ends it (§8.2) — before the transport closes. */
    closeAll(reason) {
      for (const entry of open.values()) {
        for (const chatId of [...entry.deltas.keys()]) flushDelta(entry, chatId);
        emit(entry, 'session.closing', { reason });
      }
    },
  };
}

module.exports = { createRemoteDispatcher, DISPATCHER_LIMITS: LIMITS };
