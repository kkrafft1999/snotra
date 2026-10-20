'use strict';

/**
 * The remote dispatcher (#1194): step 1 of `docs/remote-interface.md` §10 —
 * watching. It stands behind the channel's message-layer port, so that a
 * request a connection sends after `session.hello` becomes a call on the
 * desktop, and what happens there becomes an event for the connections that
 * follow the chat.
 *
 * - **Methods** (§8.1): `workspaces.list`, `chats.list`, `chat.open`,
 *   `chat.more`, `chat.close`, in a table per kind; anything else is
 *   `unknown-method`, a method the kind may not call `refused`. The channel
 *   answers `session.hello` and `session.bye` itself.
 * - **Visibility** (§7.5): a connection sees the workspaces of the release
 *   list that the desktop still knows, by `workspaceId`, and only their
 *   chats. A chat outside them is `not-found`, exactly as an unknown one.
 *   No answer and no event carries a path.
 * - **Events** (§8.2): `session.welcome` and `state` when a connection
 *   opens, `state` again when it changes; `chat.delta`, `chat.tool-line` and
 *   `chat.progress` to the connections subscribed to their chat — deltas
 *   batched per chat when the transport asks for it (protocol §17);
 *   `session.resync` when an event could not be delivered, and
 *   `session.closing` when the desktop ends the connections.
 *
 * Read only: nothing here writes a chat, switches the workspace or changes
 * the chat on the desktop's screen. Steps 2 and 3 add the methods that do.
 */

const { remoteRpcError } = require('../../shared/contracts/remote/rpc-errors');
const { isMessage } = require('../../shared/contracts/message');
const { isRecord } = require('../../shared/runtime/is-record');
const display = require('./remote-display');

/** What `session.hello` names as this message layer's limits (§8.1). */
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

/** A request the dispatcher refuses, with the reason of §6.3. */
class Refusal extends Error {
  /** @param {Parameters<typeof remoteRpcError>[1]} reason */
  constructor(reason) {
    super(reason);
    this.reason = reason;
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
 */

/**
 * @param {{
 *   desktop: import('../ports/remote-desktop-port').RemoteDesktopPort,
 *   releases: import('../ports/remote-release-port').RemoteReleasePort,
 *   word: (locale: string, message: import('../../shared/contracts/message').Message) => string,
 *   deltaBatchMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `deltaBatchMs` the transport's batching of streamed text — 150 on the relay (protocol §17), 0 sends at once
 * @returns {import('../ports/remote-message-layer-port').RemoteMessageLayerPort & { closeAll: (reason: string) => void }}
 */
function createRemoteDispatcher({
  desktop,
  releases,
  word,
  deltaBatchMs = 0,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(/** @type {any} */ (timer)),
  log = console,
}) {
  /** @type {Map<string, Open>} by connection id */
  const open = new Map();
  /** @type {Array<() => void>} */
  let unsubscribe = [];

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

  /** @param {import('../ports/remote-desktop-port').RemoteDesktopActivity} activity */
  function onActivity(activity) {
    if (activity.kind === 'workspace') {
      refreshState();
      return;
    }
    const { chatId, runId, type } = activity;
    const payload = isRecord(activity.payload) ? activity.payload : {};
    if (typeof chatId !== 'string' || !chatId) return;
    // A turn that starts or ends changes `state`.
    if (type === 'progress' && payload.type === 'run-end') {
      seenRunning.delete(chatId);
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
          // The cards of a chat arrive with step 3 (#980).
          pendingApprovals: [],
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
  };

  /** @param {RemoteConnection} connection */
  const methodsFor = (connection) => Object.keys(METHODS).filter((name) => METHODS[name].kinds.includes(connection.kind));

  // ---------------------------------------------------------------- the port

  return {
    describe: (connection) => ({ methods: methodsFor(connection), approvalResponses: [], limits: { ...LIMITS } }),

    open(connection, outlet) {
      /** @type {Open} */
      const entry = { connection, send: outlet.send, subscriptions: new Map(), deltas: new Map(), lastState: null, resyncing: false };
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
        if (error instanceof Refusal) return remoteRpcError(request.id, error.reason, wordIn);
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
