// Chats are booked by workspace. Which workspace is active, main knows (#68)
// — the renderer no longer names it.
//
// A folder switch needs one exception (#131): the renderer saves the running
// conversation only once the new folder is already active in main. Were every
// chat stamped with the active root, the old folder's chat would move into
// the new bucket. So a chat may name the root it was held under — but only
// when that is a folder opened before (`isKnownWorkspaceRoot`). Anything else
// falls back to the active root; the trust boundary of #68 stays as it was.
//
// Until #1006 these rules lived in `ipc/chat-history-handlers.js`; the
// handlers now parse and delegate.

const { DEFAULT_REASONING_LEVEL } = require('../../shared/contracts/reasoning');
const { CHAT_ACTIVATION, sanitizeChatId } = require('../../shared/contracts/chat');
const { datedSessionCost, dayKeyOf, mergeSessionCost, normalizeSessionCost, withCostDays } = require('../../shared/contracts/cost');
const { CHAT_HISTORY_UNREADABLE } = require('./chat-history-store');

/**
 * Without an attachment store the history behaves as before #94: image data
 * never lands in the chat's file, and there is no file next to it either.
 */
/** @type {ReturnType<typeof import('./chat-attachment-store').createChatAttachmentStore>} */
const NO_ATTACHMENT_STORE = {
  persistMessages: async (_chatId, messages) => messages,
  readAttachment: async () => ({ ok: false }),
  deleteChat: async () => {},
  pruneChats: async () => {},
};

/**
 * What the history uses of the chat settings service. Without it (tests, a
 * minimal set-up) the history behaves as before #211: nothing is remembered
 * per chat and nothing restored.
 *
 * @typedef {Object} ChatSessionSettingsLike
 * @property {(chatId: unknown, options?: { activation?: string }) => Promise<object>} activate
 * @property {(chatId: unknown) => object} valuesFor
 * @property {(chatId: unknown) => void} forget
 */

/** @type {ChatSessionSettingsLike} */
const NO_CHAT_SESSION_SETTINGS = {
  activate: async () => ({}),
  valuesFor: () => ({}),
  forget: () => {},
};

/**
 * @param {object} deps
 * @param {import('../ports/chat-history-store-port').ChatHistoryStorePort} deps.chatHistoryStore
 * @param {ReturnType<typeof import('./chat-attachment-store').createChatAttachmentStore>} [deps.chatAttachments]
 * @param {() => string|null} [deps.getActiveWorkspaceRoot]
 * @param {(root: string) => Promise<boolean>} [deps.isKnownWorkspaceRoot]
 * @param {ChatSessionSettingsLike} [deps.chatSessionSettings]
 * @param {(toolName: string) => (string|null)} [deps.toolCategoryOf]
 * @param {() => number} [deps.now]
 */
function createChatHistoryService({
  chatHistoryStore,
  chatAttachments = NO_ATTACHMENT_STORE,
  getActiveWorkspaceRoot = () => null,
  isKnownWorkspaceRoot = async () => false,
  chatSessionSettings = NO_CHAT_SESSION_SETTINGS,
  // A tool's category from its descriptor, for entries stored before they
  // carried one (#1008).
  toolCategoryOf = () => null,
  // A chat's time stamp is made here since #245, not in the renderer.
  // Injectable, so tests can fix an order.
  now = () => Date.now(),
}) {
  /**
   * The cost of turns in chats that have no row yet (#981): a chat is first
   * saved by the renderer, and a fast first turn can end before that save is
   * in. Its first save takes the sum along.
   *
   * @type {Map<string, import('../../shared/contracts/cost').SessionCost>}
   */
  const pendingCost = new Map();
  /**
   * Chats deleted in this run of the app (#981): a turn still under way in one
   * of them must not write it back.
   *
   * @type {Set<string>}
   */
  const deletedIds = new Set();

  /**
   * @param {unknown} sessionRow
   * @returns {Promise<string|null>}
   */
  async function resolveSessionWorkspaceRoot(sessionRow) {
    const activeRoot = getActiveWorkspaceRoot();
    if (!sessionRow || typeof sessionRow !== 'object' || !('workspaceRoot' in sessionRow)) {
      return activeRoot;
    }
    const claimed = chatHistoryStore.normalizeWorkspaceRoot(sessionRow.workspaceRoot);
    if (claimed === null) {
      // An explicit `null` means "held without a folder" and gets its own
      // bucket. An unusable string is no wish but an error — it lands with
      // the active root.
      const raw = sessionRow.workspaceRoot;
      return typeof raw === 'string' && raw.trim() ? activeRoot : null;
    }
    if (claimed === chatHistoryStore.normalizeWorkspaceRoot(activeRoot)) return activeRoot;
    return (await isKnownWorkspaceRoot(claimed)) ? claimed : activeRoot;
  }

  /**
   * The history file is there but could not be read (#473), so the store
   * refuses to write its empty stand-in over it. The chat goes on in memory
   * and this one save is skipped — the new chat or the folder switch that
   * asked for it must not fail over it. `unreadable` tells the renderer that
   * nothing was saved, so it can say so in the chat (#977).
   *
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T | { ok: false, unreadable: true }>}
   */
  async function skipWhenUnreadable(run) {
    try {
      return await run();
    } catch (error) {
      if (error?.code !== CHAT_HISTORY_UNREADABLE) throw error;
      return { ok: false, unreadable: true };
    }
  }

  /**
   * Which bucket gets the active chat id? The chat's own — otherwise the
   * `setActiveChatId` right after a save would write the old conversation
   * into the new folder's bucket (#131).
   *
   * @param {unknown} id
   */
  async function bucketKeyForSession(id) {
    const session = typeof id === 'string' ? await chatHistoryStore.getSessionMeta(id) : null;
    const root = session
      ? chatHistoryStore.normalizeWorkspaceRoot(session.workspaceRoot)
      : chatHistoryStore.normalizeWorkspaceRoot(getActiveWorkspaceRoot());
    return chatHistoryStore.workspaceBucketKey(root);
  }

  /**
   * The list carries no messages (#985): every chat of the folder with what
   * its row shows, and which one the folder opens with.
   */
  async function listForActiveFolder() {
    const wsRoot = chatHistoryStore.normalizeWorkspaceRoot(getActiveWorkspaceRoot());
    const sessions = (await chatHistoryStore.listSessions())
      .filter((s) => chatHistoryStore.sessionMatchesWorkspace(s, wsRoot))
      .map((s) => chatHistoryStore.normalizeSessionMetaForList(s))
      .filter(Boolean);
    const activeChatId = await chatHistoryStore.getActiveChatId(chatHistoryStore.workspaceBucketKey(wsRoot));
    return { sessions, activeChatId, workspaceRoot: wsRoot };
  }

  /**
   * One chat with its messages, as the list used to carry every chat (#985).
   * Only one of the active folder's — the same chats the list hands out (#68).
   *
   * @param {unknown} rawId
   */
  async function getSession(rawId) {
    const id = sanitizeChatId(rawId);
    if (!id) return null;
    const wsRoot = chatHistoryStore.normalizeWorkspaceRoot(getActiveWorkspaceRoot());
    const session = await chatHistoryStore.getSession(id);
    if (!session || !chatHistoryStore.sessionMatchesWorkspace(session, wsRoot)) return null;
    return chatHistoryStore.normalizeSessionForLoad(session, { toolCategoryOf });
  }

  // --- Reading for the remote front ends (#1194) ----------------------------
  // Which folders a remote may see is the release list's word; these only
  // read, and never touch the chat on the desktop's screen.

  /**
   * The rows of every chat kept under one of `roots`, without messages.
   * @param {unknown[]} roots
   */
  async function listForRoots(roots) {
    const wanted = (Array.isArray(roots) ? roots : [])
      .map((root) => chatHistoryStore.normalizeWorkspaceRoot(root))
      .filter((root) => root !== null);
    if (wanted.length === 0) return [];
    return (await chatHistoryStore.listSessions())
      .filter((s) => wanted.some((root) => chatHistoryStore.sessionMatchesWorkspace(s, root)))
      .map((s) => chatHistoryStore.normalizeSessionMetaForList(s))
      .filter(Boolean);
  }

  /**
   * One chat with its messages as the window loads it, in whichever folder it is kept.
   * @param {unknown} rawId
   */
  async function loadForDisplay(rawId) {
    const id = sanitizeChatId(rawId);
    const session = id ? await chatHistoryStore.getSession(id) : null;
    return session ? chatHistoryStore.normalizeSessionForLoad(session, { toolCategoryOf }) : null;
  }

  /**
   * Saves a chat as the renderer holds it. Model, mode, level and overrides
   * are main's word, the time stamp is set here, and the oldest chats beyond
   * `MAX_CHAT_SESSIONS` go with their images.
   *
   * @param {any} sessionRow  straight from the renderer
   */
  function saveSession(sessionRow) {
    return skipWhenUnreadable(() => chatHistoryStore.withChatHistoryLock(async () => {
      const sessionId = typeof sessionRow?.id === 'string' ? sessionRow.id.trim() : '';
      const existing = sessionId ? await chatHistoryStore.getSession(sessionId) : null;
      const titleProvided =
        typeof sessionRow?.title === 'string' && sessionRow.title.trim().length > 0;
      // Images to the disk first, normalised afterwards: normalising takes
      // only file references, so base64 never reaches the history file (#94).
      const messages = sessionId
        ? await chatAttachments.persistMessages(sessionId, sessionRow?.messages)
        : sessionRow?.messages;
      // Model and permission mode come from main alone (#211). Whatever the
      // renderer sends along is dropped — otherwise it would be the source of
      // the right to "Auto" (concept §5). Known is the value remembered last,
      // else the one already stored.
      const sessionSettings = {
        modelPresetId: existing?.modelPresetId,
        toolPermissionMode: existing?.toolPermissionMode,
        // The reasoning level likewise (#725): main's word, never the
        // renderer's. A chat saved for the first time gets the default if
        // nothing was chosen: a row without a level is one from before #726,
        // which takes the level of its old entry when it comes on screen.
        reasoningEffort: existing ? existing.reasoningEffort : DEFAULT_REASONING_LEVEL,
        // What the chat switched for itself (#774) — accepted on a card in
        // main, never sent by the renderer.
        configOverrides: existing?.configOverrides,
        ...chatSessionSettings.valuesFor(sessionId),
      };
      const normalized = chatHistoryStore.normalizeSessionForStore(
        {
          ...(sessionRow || {}),
          messages,
          workspaceRoot: await resolveSessionWorkspaceRoot(sessionRow),
          ...sessionSettings,
          // The cost is main's word as well (#981): summed per turn by the
          // conversation service, never taken from the renderer.
          cost: mergeSessionCost(existing?.cost, pendingCost.get(sessionId)),
          // A time the renderer sends does not count (#245): it writes the chat
          // also when nothing was said — on leaving, on a model switch, for a
          // title that came later. Main sets the stamp just below, and only for
          // a turn.
          updatedAt: undefined,
        },
        {
          existingTitle: titleProvided ? undefined : existing?.title,
          requireMessages: true,
        }
      );
      if (!normalized) return { ok: false };
      const previousUpdatedAt = typeof existing?.updatedAt === 'number' && Number.isFinite(existing.updatedAt) ? existing.updatedAt : null;
      normalized.updatedAt =
        existing && previousUpdatedAt !== null && !chatHistoryStore.storedChatMessagesChanged(existing.messages, normalized.messages)
          ? previousUpdatedAt
          : now();
      // The store drops the oldest chats beyond MAX_CHAT_SESSIONS, with their
      // folder pointers.
      const { droppedIds } = await chatHistoryStore.saveSession(normalized);
      // Under the same lock: the images of the chats this save dropped go by
      // id. Everything else without a session is swept only while no history
      // lies moved aside next to this one — the folders may belong to its
      // chats, and the copy is kept so that it can be recovered (#565).
      pendingCost.delete(sessionId);
      for (const id of droppedIds) await chatAttachments.deleteChat(id);
      if (!(await chatHistoryStore.hasSetAsideChatHistory())) {
        await chatAttachments.pruneChats((await chatHistoryStore.listSessions()).map((s) => s.id));
      }
      return { ok: true };
    }));
  }

  /**
   * @param {unknown} rawId
   */
  function deleteSession(rawId) {
    return skipWhenUnreadable(() => chatHistoryStore.withChatHistoryLock(async () => {
      // One id for the list, the pointers, the folder and the settings (#567).
      const id = sanitizeChatId(rawId);
      if (!id) return { ok: false };
      // The chat's file, its entry and every folder pointer to it.
      deletedIds.add(id);
      await chatHistoryStore.deleteSession(id);
      pendingCost.delete(id);
      await chatAttachments.deleteChat(id);
      chatSessionSettings.forget(id);
      return { ok: true };
    }));
  }

  /**
   * @param {unknown} id  a chat id, or null/empty for none
   */
  function setActive(id) {
    return skipWhenUnreadable(() => chatHistoryStore.withChatHistoryLock(async () => {
      const wsKey = await bucketKeyForSession(id);
      if (id === null || id === undefined || id === '') {
        await chatHistoryStore.setActiveChatId(wsKey, null);
      } else if (typeof id === 'string') {
        // A pointer that stays as it was is not written again (#1060, #564).
        await chatHistoryStore.setActiveChatId(wsKey, id);
      }
      return { ok: true };
    }));
  }

  /**
   * Restores the chat's model and permission mode (#211). The renderer names
   * only the id; which values stand behind it, main knows.
   *
   * @param {unknown} id
   * @param {unknown} activation
   */
  async function activate(id, activation) {
    const chatId = sanitizeChatId(id);
    // Only exactly `explicit` may bring a stored "Auto" back; a missing or
    // unknown value is the automatic restore (#567).
    const explicit = activation === CHAT_ACTIVATION.EXPLICIT;
    const applied = await chatSessionSettings.activate(chatId, {
      activation: explicit ? CHAT_ACTIVATION.EXPLICIT : CHAT_ACTIVATION.AUTO,
    });
    return { ok: true, ...applied };
  }

  /**
   * The image data of a stored attachment (#94), asked for only when shown.
   *
   * @param {unknown} chatId
   * @param {unknown} file
   */
  async function readAttachment(chatId, file) {
    if (typeof chatId !== 'string' || !chatId.trim()) return { ok: false };
    if (typeof file !== 'string' || !file) return { ok: false };
    return chatAttachments.readAttachment(chatId.trim(), file);
  }

  // --- The chat-history port of the core (#981) -----------------------------

  /**
   * A chat with its messages for the conversation service — in whichever
   * folder it is kept: a run that ended in the background may belong to a
   * folder that is no longer open.
   *
   * @param {string} chatId
   * @returns {Promise<import('../../application/ports/chat-history-port').StoredChat|null>}
   */
  async function load(chatId) {
    const id = sanitizeChatId(chatId);
    const session = id ? await chatHistoryStore.getSession(id) : null;
    if (!session) return null;
    return {
      id: session.id,
      title: session.title,
      messages: Array.isArray(session.messages) ? session.messages : [],
      cost: normalizeSessionCost(session.cost),
      workspaceRoot: chatHistoryStore.normalizeWorkspaceRoot(session.workspaceRoot),
      ...(session.tokenUsage ? { tokenUsage: session.tokenUsage } : {}),
    };
  }

  /**
   * Writes a chat for the conversation service (#981) — the same rules as a
   * save from the renderer, and never one deleted in this run of the app.
   *
   * @param {import('../../application/ports/chat-history-port').ChatToSave} chat
   * @param {{ markActive?: boolean }} [options]
   * @returns {Promise<{ ok: boolean, unreadable?: boolean }>}
   */
  async function save(chat, { markActive = false } = {}) {
    const id = sanitizeChatId(chat?.id);
    if (!id || deletedIds.has(id)) return { ok: false };
    const saved = /** @type {{ ok: boolean, unreadable?: boolean }} */ (await saveSession({ ...chat, id }));
    if (saved.ok && markActive) await setActive(id);
    return saved;
  }

  /**
   * Adds a turn's cost to the chat's sum (#949, #981), booked on today's date
   * for the usage report (#1258). A sum from before that has no days yet: it
   * is pinned to the chat's last save first, so it does not move to today.
   *
   * @param {string} chatId
   * @param {unknown} cost
   */
  function addCost(chatId, cost) {
    return /** @type {Promise<import('../../shared/contracts/cost').SessionCost|null>} */ (chatHistoryStore.withChatHistoryLock(async () => {
      const id = sanitizeChatId(chatId);
      if (!id) return null;
      const turnCost = datedSessionCost(cost, dayKeyOf(now()));
      const meta = await chatHistoryStore.getSessionMeta(id);
      if (!meta) {
        const pending = mergeSessionCost(pendingCost.get(id), turnCost);
        if (pending) pendingCost.set(id, pending);
        return pending;
      }
      const next = mergeSessionCost(withCostDays(meta.cost, dayKeyOf(meta.updatedAt)), turnCost);
      if (next) await chatHistoryStore.patchSession(id, { cost: next });
      return next;
    }));
  }

  /**
   * Names a stored chat (#359, #981). A chat deleted meanwhile is not brought back.
   *
   * @param {string} chatId
   * @param {string} title
   */
  function setTitle(chatId, title) {
    return /** @type {Promise<boolean>} */ (chatHistoryStore.withChatHistoryLock(async () => {
      const id = sanitizeChatId(chatId);
      if (!id || !(await chatHistoryStore.getSessionMeta(id))) return false;
      return chatHistoryStore.patchSession(id, { title });
    }));
  }

  return {
    listForActiveFolder,
    getSession,
    listForRoots,
    loadForDisplay,
    saveSession,
    deleteSession,
    setActive,
    activate,
    readAttachment,
    load,
    save,
    addCost,
    setTitle,
  };
}

module.exports = { createChatHistoryService };
