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
const { normalizeMessageOrigin } = require('../../shared/contracts/remote/message-origin');
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
 *   respondToApproval?: import('../../application/ports/remote-desktop-port').RemoteDesktopPort['respondToApproval'],
 *   activity: {
 *     subscribe: import('../../application/ports/remote-desktop-port').RemoteDesktopPort['subscribe'],
 *     publishRun: (event: { chatId: string, runId: string, type: string, payload: unknown }) => void,
 *   },
 *   conversation?: Pick<ReturnType<typeof import('../../application/chat/conversation-service').createConversationService>, 'runTurn' | 'stopChat'>,
 *   llm?: Pick<import('../../application/ports/llm-port').LlmPort, 'resolveChatTarget' | 'validateTarget' | 'reasoningLevelsFor'>,
 *   chatMode?: (chatId: string) => Promise<string>,
 *   rememberReasoning?: (chatId: string, level: string) => Promise<boolean>,
 *   describeConfiguration?: (input: { chatId: string, workspaceRoot: string }) => Promise<{ skills?: any[], tools?: any[] }>,
 *   followInWindow?: (event: { chatId: string, runId: string|null, type: string, payload: Record<string, unknown> }) => void,
 *   switchInWindow?: (root: string) => Promise<import('./window-workspace-switch').WindowSwitchOutcome>,
 *   activateKnownFolder?: (root: string) => Promise<string|null>,
 *   onSwitched?: (root: string) => void,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `normalizeRoot` the chat history's, so that folders compare alike everywhere;
 *   `conversation` and `llm` for the turns of step 2, `chatMode` and
 *   `describeConfiguration` for a chat's configuration, `rememberReasoning` keeps the level a
 *   phone chose, and `followInWindow` tells the window of it (#1304); `followInWindow` hands a remote turn's
 *   events to the window, which did not start it (step 2b), `turn-started` first;
 *   `switchInWindow` asks the window to open a folder, `activateKnownFolder` opens it when there
 *   is no window, `onSwitched` tells the desktop it happened (step 2c)
 * @returns {import('../../application/ports/remote-desktop-port').RemoteDesktopPort}
 */
function createRemoteDesktopAdapter({
  chatHistory,
  workspaceFolderStore,
  getActiveWorkspaceRoot,
  normalizeRoot,
  runningChatIds,
  listPendingApprovals,
  respondToApproval = () => ({ ok: false, reason: 'not-found' }),
  activity,
  conversation,
  llm,
  chatMode = async () => 'smart',
  rememberReasoning = async () => false,
  describeConfiguration = async () => ({ skills: [], tools: [] }),
  followInWindow = () => {},
  switchInWindow = async () => 'no-window',
  activateKnownFolder = async () => null,
  onSwitched = () => {},
  log = console,
}) {
  /** @param {string} chatId */
  async function reasoningLevelsOf(chatId) {
    if (typeof llm?.reasoningLevelsFor !== 'function') return [];
    const levels = await llm.reasoningLevelsFor({ chatId });
    return Array.isArray(levels) ? levels.filter((level) => typeof level === 'string') : [];
  }

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
    pendingApprovals: () => /** @type {Array<Record<string, unknown>>} */ (listPendingApprovals()),
    respondToApproval: (requestId, answer, by) => respondToApproval(requestId, answer, by),
    subscribe: (listener) => activity.subscribe(listener),

    async startTurn({ connectionId, chatId, text, runId, origin }) {
      /** @param {Parameters<typeof followInWindow>[0]} event */
      const tellWindow = (event) => {
        try {
          followInWindow(event);
        } catch (error) {
          // The window not following never holds up the turn.
          log.warn(`[remote] the window could not follow a remote turn (${error?.name || 'error'})`);
        }
      };
      if (!conversation || !llm) return { ok: false, reason: 'unavailable' };
      // No provider set up for this chat's model: refused before anything is written (§8.1).
      const target = await llm.resolveChatTarget({ chatId });
      if (isError(target) || (await llm.validateTarget(/** @type {any} */ (target), { forSend: true }))) {
        return { ok: false, reason: 'unavailable' };
      }
      // Where the question came from goes with it into the chat (#1197).
      const markOf = normalizeMessageOrigin(origin);
      /** @type {{ content: string, origin?: { kind: string, client: string } }} */
      const question = markOf ? { content: text, origin: markOf } : { content: text };
      let inWindow = false;
      /** @param {{ type?: string, payload?: unknown }} event */
      const publish = (event) => {
        if (!event?.type || !TURN_EVENTS.has(event.type)) return;
        const payload = event.payload && typeof event.payload === 'object' ? /** @type {Record<string, unknown>} */ (event.payload) : {};
        activity.publishRun({ chatId, runId, type: event.type, payload });
        // The first save that went through holds the question (#981): from
        // then on the window shows the turn, as one of its own (step 2b).
        if (!inWindow && payload.type === 'chat-saved' && payload.ok === true) {
          inWindow = true;
          tellWindow({ chatId, runId, type: 'turn-started', payload: { content: text, ...(question.origin ? { origin: question.origin } : {}) } });
        }
        if (inWindow) tellWindow({ chatId, runId, type: event.type, payload });
      };
      // Not awaited: the answer is the accepted turn (§6.5); its end is `run-end`.
      void conversation.runTurn({
        sessionId: remoteSessionId(connectionId),
        chatId,
        message: question,
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

    async activateWorkspace(root) {
      let outcome = await switchInWindow(root);
      // No window to ask, nothing on show to settle: main opens it itself.
      if (outcome === 'no-window') outcome = (await activateKnownFolder(root)) ? 'switched' : 'refused';
      if (outcome !== 'switched') return { ok: false, reason: outcome };
      onSwitched(root);
      return { ok: true };
    },

    async setReasoning(chatId, level) {
      // Only a level the chat's model takes, checked here as the window's picker is in main.
      if (!(await reasoningLevelsOf(chatId)).includes(level)) return { ok: false, reason: 'invalid' };
      if (!(await rememberReasoning(chatId, level))) return { ok: false, reason: 'invalid' };
      try {
        followInWindow({ chatId, runId: null, type: 'reasoning-changed', payload: {} });
      } catch (error) {
        // The window not following never undoes the change.
        log.warn(`[remote] the window could not follow a reasoning level (${error?.name || 'error'})`);
      }
      return { ok: true, reasoning: level };
    },

    async chatConfiguration(chatId, root) {
      const [target, mode, levels, described] = await Promise.all([
        llm ? llm.resolveChatTarget({ chatId }) : null,
        chatMode(chatId),
        reasoningLevelsOf(chatId),
        describeConfiguration({ chatId, workspaceRoot: root }),
      ]);
      const resolved = target && !isError(target) ? /** @type {any} */ (target) : null;
      const model = typeof resolved?.model === 'string' ? resolved.model : '';
      // The level the chat runs with, as the model button shows it (#1304).
      const reasoning = typeof resolved?.reasoningEffort === 'string' && resolved.reasoningEffort ? resolved.reasoningEffort : null;
      return {
        model: { label: model },
        mode,
        reasoning,
        reasoningLevels: reasoning ? levels : [],
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
