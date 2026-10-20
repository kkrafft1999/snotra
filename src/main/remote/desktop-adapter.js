'use strict';

/**
 * What the remote dispatcher reads of the desktop (#1194): the folders it
 * knows, the one that is open, the stored chats, which of them run or wait
 * for a card, and the activity the window's handlers publish — and what it
 * asks of it in step 2: a turn through the conversation service (#981), a
 * stop, a chat's configuration.
 *
 * Nothing here goes through `chatHistory:activate`: a remote that opens or
 * writes in a chat never changes the one on the desktop's screen, and its
 * turn runs with that chat's own model, mode and level (§7.3).
 */

const { CHAT_ENGINE_EVENTS } = require('../../application/chat/chat-engine');
const { createRunEndEvent } = require('../../shared/contracts/chat');
const { createMessage } = require('../../shared/contracts/message');

/**
 * A remote front end's turns are kept under a session of their own, apart
 * from every window's (`webContents` ids are numbers). The window answers
 * their cards until the front end can (#1194 step 3).
 */
const REMOTE_SESSION_PREFIX = 'remote:';

/** @param {string} connectionId */
const remoteSessionId = (connectionId) => `${REMOTE_SESSION_PREFIX}${connectionId}`;

/** @param {unknown} sessionId */
const isRemoteSessionId = (sessionId) => typeof sessionId === 'string' && sessionId.startsWith(REMOTE_SESSION_PREFIX);

/** @type {Set<string>} */
const TURN_EVENTS = new Set(Object.values(CHAT_ENGINE_EVENTS));

/** @param {unknown} value */
const isError = (value) => !value || (typeof value === 'object' && 'error' in value && Boolean(/** @type {any} */ (value).error));

/**
 * @param {unknown} chatId
 * @returns {chatId is string}
 */
const isChatId = (chatId) => typeof chatId === 'string' && chatId.length > 0;

/**
 * @param {{
 *   chatHistory: { listForRoots: (roots: unknown[]) => Promise<any[]>, loadForDisplay: (id: unknown) => Promise<any> },
 *   workspaceFolderStore: { getValidatedFolderHistory: () => Promise<string[]> },
 *   getActiveWorkspaceRoot: () => string|null,
 *   normalizeRoot: (root: unknown) => string|null,
 *   runningChatIds: () => Iterable<string|null>,
 *   listPendingApprovals: () => Array<{ chatId?: unknown }>,
 *   activity: {
 *     subscribe: import('../../application/ports/remote-desktop-port').RemoteDesktopPort['subscribe'],
 *     publishRun: (event: { chatId: string, runId: string, type: string, payload: unknown }) => void,
 *   },
 *   conversation?: Pick<ReturnType<typeof import('../../application/chat/conversation-service').createConversationService>, 'runTurn' | 'stopChat'>,
 *   llm?: Pick<import('../../application/ports/llm-port').LlmPort, 'resolveChatTarget' | 'validateTarget'>,
 *   chatMode?: (chatId: string) => Promise<string>,
 *   reasoningFor?: (chatId: string) => Promise<string|null>,
 *   describeConfiguration?: (input: { chatId: string, workspaceRoot: string }) => Promise<{ skills?: any[], tools?: any[] }>,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `normalizeRoot` the chat history's, so that folders compare alike everywhere;
 *   `conversation` and `llm` for the turns of step 2, `chatMode`, `reasoningFor` and
 *   `describeConfiguration` for a chat's configuration
 * @returns {import('../../application/ports/remote-desktop-port').RemoteDesktopPort}
 */
function createRemoteDesktopAdapter({
  chatHistory,
  workspaceFolderStore,
  getActiveWorkspaceRoot,
  normalizeRoot,
  runningChatIds,
  listPendingApprovals,
  activity,
  conversation,
  llm,
  chatMode = async () => 'smart',
  reasoningFor = async () => null,
  describeConfiguration = async () => ({ skills: [], tools: [] }),
  log = console,
}) {
  return {
    async knownWorkspaces() {
      const roots = new Set();
      for (const folder of await workspaceFolderStore.getValidatedFolderHistory()) {
        const root = normalizeRoot(folder);
        if (root) roots.add(root);
      }
      const active = normalizeRoot(getActiveWorkspaceRoot());
      if (active) roots.add(active);
      return [...roots];
    },
    activeWorkspace: () => normalizeRoot(getActiveWorkspaceRoot()),
    async listChats(roots) {
      return (await chatHistory.listForRoots(roots)).map((row) => ({
        chatId: row.id,
        root: normalizeRoot(row.workspaceRoot),
        title: row.title,
        updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
        messageCount: Number.isInteger(row.messageCount) ? row.messageCount : 0,
      }));
    },
    async loadChat(chatId) {
      const session = await chatHistory.loadForDisplay(chatId);
      if (!session) return null;
      return {
        chatId: session.id,
        root: normalizeRoot(session.workspaceRoot),
        title: session.title || createMessage('chat.title.new'),
        updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : 0,
        messages: Array.isArray(session.messages) ? session.messages : [],
      };
    },
    runningChats: () => new Set([...runningChatIds()].filter(isChatId)),
    awaitingApproval: () => new Set(listPendingApprovals().map((request) => request?.chatId).filter(isChatId)),
    subscribe: (listener) => activity.subscribe(listener),

    async startTurn({ connectionId, chatId, text, runId }) {
      if (!conversation || !llm) return { ok: false, reason: 'unavailable' };
      // No provider set up for this chat's model: refused before anything is written (§8.1).
      const target = await llm.resolveChatTarget({ chatId });
      if (isError(target) || (await llm.validateTarget(/** @type {any} */ (target), { forSend: true }))) {
        return { ok: false, reason: 'unavailable' };
      }
      /** @param {{ type?: string, payload?: unknown }} event */
      const publish = (event) => {
        if (!event?.type || !TURN_EVENTS.has(event.type)) return;
        activity.publishRun({ chatId, runId, type: event.type, payload: event.payload && typeof event.payload === 'object' ? event.payload : {} });
      };
      // Not awaited: the answer is the accepted turn (§6.5); its end is `run-end`.
      void conversation.runTurn({
        sessionId: remoteSessionId(connectionId),
        chatId,
        message: { content: text },
        // The open workspace, never one the request names (#68); the dispatcher
        // only lets a chat of that workspace through.
        workspaceRoot: getActiveWorkspaceRoot(),
        onEvent: publish,
      }).catch((error) => {
        log.warn(`[remote] a turn from a remote front end failed (${error?.name || 'error'})`);
      }).finally(() => publish({ type: CHAT_ENGINE_EVENTS.PROGRESS, payload: createRunEndEvent() }));
      return { ok: true };
    },

    stopChat: (chatId) => (conversation ? conversation.stopChat(chatId) : false),

    async chatConfiguration(chatId, root) {
      const [target, mode, reasoning, described] = await Promise.all([
        llm ? llm.resolveChatTarget({ chatId }) : null,
        chatMode(chatId),
        reasoningFor(chatId),
        describeConfiguration({ chatId, workspaceRoot: root }),
      ]);
      const model = !isError(target) && typeof /** @type {any} */ (target).model === 'string' ? /** @type {any} */ (target).model : '';
      return {
        model: { label: model },
        mode,
        reasoning: typeof reasoning === 'string' && reasoning ? reasoning : null,
        skills: (Array.isArray(described?.skills) ? described.skills : [])
          .filter((skill) => typeof skill?.name === 'string')
          .map((skill) => ({ name: skill.name, state: String(skill.state || '') })),
        tools: (Array.isArray(described?.tools) ? described.tools : [])
          .filter((tool) => typeof tool?.name === 'string')
          .map((tool) => ({ name: tool.name, on: tool.on === true })),
      };
    },
  };
}

module.exports = { createRemoteDesktopAdapter, remoteSessionId, isRemoteSessionId };
