const { isDerivedChatTitle } = require('../../shared/contracts/chat');
const { CHAT_PROGRESS_TYPES } = require('../../shared/contracts/enums');
const { createMessage } = require('../../shared/contracts/message');
const { createTurnAnswer, applyTurnEvent, answerForCheckpoint, settleTurn } = require('./turn-messages');

/**
 * The conversation around a turn (#981). The engine runs one turn; the chat it
 * belongs to is kept here, through the chat-history port, so that no front end
 * has to repeat it: the question and the answer appended and saved — after
 * every finished step as well (#979) —, the turn's cost added to the chat's
 * sum (#949), the chat named after its first answer.
 *
 * @typedef {import('../ports/chat-history-port').ChatHistoryPort} ChatHistoryPort
 * @typedef {import('../ports/chat-history-port').StoredChatMessage} StoredChatMessage
 * @typedef {import('../ports/chat-history-port').StoredChat} StoredChat
 * @typedef {import('../../shared/contracts/cost').SessionCost} SessionCost
 * @typedef {Pick<ReturnType<typeof import('./chat-engine').createChatEngine>, 'send' | 'generateTitle' | 'abort'>} ConversationEngine
 * @typedef {Parameters<ConversationEngine['send']>[0]} TurnRequest
 * @typedef {import('./turn-messages').EngineEvent} EngineEvent
 * @typedef {import('./turn-messages').ChatMessage} ChatMessage
 *
 * @typedef {Object} TurnInput
 * @property {string|number} sessionId  the front end's window or connection
 * @property {string} chatId
 * @property {{ content?: unknown, attachments?: unknown[] }} message  the new question; attachments with their data
 * @property {string|null} [workspaceRoot]
 * @property {string|null} [selectedPath]
 * @property {boolean} [selectedIsDirectory]
 * @property {(event: EngineEvent) => void} [onEvent]
 *
 * @typedef {Object} RunningTurn
 * @property {boolean} stopped    the user stopped it: it settles as far as it had come
 * @property {boolean} abandoned  its front end went away (#979): nothing more is written
 */

/**
 * The first question and the first answer of a chat, when the chat has both —
 * what a title is made from.
 *
 * @param {StoredChatMessage[]} messages
 * @returns {{ firstUser: StoredChatMessage, firstAnswer: StoredChatMessage } | null}
 */
function titleSource(messages) {
  const said = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.isError);
  const firstUser = said.find((m) => m.role === 'user');
  const firstAnswer = said.find((m) => m.role === 'assistant');
  return firstUser && firstAnswer ? { firstUser, firstAnswer } : null;
}

/**
 * A progress event for the front end that names its own type.
 *
 * @param {string} type
 * @param {Record<string, unknown>} fields
 * @returns {EngineEvent}
 */
function progressEvent(type, fields) {
  return { type: 'progress', payload: { type, ...fields } };
}

/**
 * @param {object} deps
 * @param {ConversationEngine} deps.engine
 * @param {ChatHistoryPort} deps.history
 * @param {(error: unknown) => string} [deps.describeError]  an engine error as the chat shows it, in the interface's language
 */
function createConversationService({ engine, history, describeError = (error) => String(error ?? '') }) {
  if (!engine || !history) throw new Error('createConversationService requires an engine and a chat-history port.');

  /** @type {Set<Promise<void>>} names still being made */
  const background = new Set();
  /** @type {Map<string, RunningTurn>} the turns under way, by front end and chat */
  const running = new Map();
  /** @param {string|number} sessionId @param {string} chatId */
  const runKey = (sessionId, chatId) => `${sessionId}\u0000${chatId}`;

  /**
   * Adds a turn's cost to the chat (#949). Undefined when it could not be
   * written: the reply then carries no sum, and the chat keeps the one it had.
   *
   * @param {string} chatId
   * @param {unknown} result
   * @returns {Promise<SessionCost|null|undefined>}
   */
  async function addTurnCost(chatId, result) {
    const turnCost = result && typeof result === 'object' && 'cost' in result ? result.cost : null;
    if (!turnCost || typeof chatId !== 'string' || !chatId) return undefined;
    try {
      return await history.addCost(chatId, turnCost);
    } catch (error) {
      // The turn stands without its sum; the error goes to main's log.
      console.error('[conversation] the turn\'s cost was not added:', error);
      return undefined;
    }
  }

  /**
   * Runs a turn on messages the front end holds and adds what it cost to the
   * chat. The reply carries the chat's new sum as `chatCost`.
   *
   * @param {TurnRequest} request
   */
  async function sendTurn(request) {
    const result = await engine.send(request);
    const chatId = request?.payload?.chatId;
    const chatCost = await addTurnCost(typeof chatId === 'string' ? chatId : '', result);
    return chatCost === undefined ? result : { ...result, chatCost };
  }

  /**
   * A stored chat's messages as the model is sent them: role, text and the
   * images, read back from where the history keeps them (#94) — the images
   * of earlier turns go along as they did when the renderer held them.
   *
   * @param {string} chatId
   * @param {ChatMessage[]} messages
   */
  async function messagesForModel(chatId, messages) {
    return Promise.all(messages.map(async (message) => {
      /** @type {{ role: string, content: unknown, attachments?: unknown[] }} */
      const out = { role: message.role, content: message.content ?? '' };
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      if (attachments.length === 0) return out;
      out.attachments = await Promise.all(attachments.map(async (/** @type {any} */ attachment) => {
        if (!attachment || typeof attachment !== 'object' || attachment.dataBase64 || !attachment.file) return attachment;
        const read = await history.readAttachment(chatId, attachment.file);
        return read?.ok ? { ...attachment, mediaType: read.mediaType || attachment.mediaType, dataBase64: read.dataBase64 } : attachment;
      }));
      return out;
    }));
  }

  /**
   * Runs a turn in a stored chat (#981): the chat is loaded, the question
   * appended and saved, the turn run on the stored history, saved after each
   * finished step while it runs (#979), and saved once more when it settles,
   * with its cost. The front end sends only the question and the chat id.
   *
   * Events go to `onEvent` as the engine sends them, plus `chat-saved` after
   * every save (whether it went through, #977) and `chat-named` when the chat
   * got its name.
   *
   * @param {TurnInput} input
   */
  async function runTurn({ sessionId, chatId, message, workspaceRoot = null, selectedPath = null, selectedIsDirectory = false, onEvent = () => {} }) {
    const stored = await history.load(chatId);
    /** @type {ChatMessage} */
    const question = { role: 'user', content: typeof message?.content === 'string' ? message.content : '' };
    if (Array.isArray(message?.attachments) && message.attachments.length > 0) question.attachments = message.attachments;
    /** @type {ChatMessage[]} */
    const asked = [...(stored?.messages || []), question];
    const answer = createTurnAnswer();
    /** @type {RunningTurn} */
    const turn = { stopped: false, abandoned: false };
    const key = runKey(sessionId, chatId);
    running.set(key, turn);
    // A stored chat stays under its folder; a new one goes under the open one.
    const base = stored ? { id: chatId, workspaceRoot: stored.workspaceRoot ?? null } : { id: chatId };

    /**
     * @param {ChatMessage[]} messages
     * @param {{ markActive?: boolean, tokenUsage?: unknown }} [options]
     */
    const save = async (messages, options = {}) => {
      if (turn.abandoned) return;
      let outcome;
      try {
        outcome = await history.save({ ...base, messages, ...(options.tokenUsage ? { tokenUsage: options.tokenUsage } : {}) }, { markActive: options.markActive === true });
      } catch (error) {
        console.error('[conversation] the chat was not saved:', error);
        outcome = { ok: false };
      }
      onEvent(progressEvent(CHAT_PROGRESS_TYPES.CHAT_SAVED, {
        ok: outcome?.ok === true,
        ...(outcome?.unreadable ? { unreadable: true } : {}),
      }));
    };

    // One write at a time; steps that finish meanwhile go with the next one.
    /** @type {Promise<void>} */
    let writing = Promise.resolve();
    let checkpointDue = false;
    const checkpoint = () => {
      if (checkpointDue) return;
      checkpointDue = true;
      writing = writing.then(async () => {
        checkpointDue = false;
        if (answer.streaming) await save([...asked, answerForCheckpoint(answer)]);
      });
    };

    /** @type {any} */
    let result;
    /** @type {unknown} */
    let thrown = null;
    try {
      // The question is part of the chat from now on, and the chat the one
      // its folder opens with.
      await save([...asked, answerForCheckpoint(answer)], { markActive: true });
      result = await engine.send({
        sessionId,
        payload: {
          messages: await messagesForModel(chatId, asked),
          workspaceRoot,
          selectedPath,
          selectedIsDirectory,
          chatId,
        },
        onEvent: (/** @type {EngineEvent} */ event) => {
          // Once stopped, the answer stays as it was at the stop (the screen
          // takes nothing more either); the events still go out.
          if (!turn.stopped && applyTurnEvent(answer, event)) checkpoint();
          onEvent(event);
        },
      });
    } catch (error) {
      // A run that throws still leaves its turn in the chat, as the renderer
      // wrote it before #981: the steps so far and the error below them.
      thrown = error;
      result = { error: createMessage('chat.error.runLost') };
    } finally {
      if (running.get(key) === turn) running.delete(key);
    }
    await writing;
    const chatCost = await addTurnCost(chatId, result);
    if (!turn.abandoned) {
      const settled = settleTurn(asked, answer, result, { describeError, stopped: turn.stopped });
      const usage = result && typeof result === 'object' ? ('contextUsage' in result && result.contextUsage) || result.usage : null;
      await save(settled, { tokenUsage: usage || stored?.tokenUsage });
      // In the background: the name must not hold up the answer, and its
      // failure must not disturb the chat.
      const naming = nameChat(chatId).then(({ title }) => {
        if (title) onEvent(progressEvent(CHAT_PROGRESS_TYPES.CHAT_NAMED, { title }));
      }, (error) => console.error('[conversation] the chat was not named:', error));
      background.add(naming);
      void naming.finally(() => background.delete(naming));
    }
    if (thrown) throw thrown;
    return chatCost === undefined ? result : { ...result, chatCost };
  }

  /**
   * The user stopped the turn of a chat (or every turn of the front end): it
   * settles as far as it had come.
   *
   * @param {string|number} sessionId
   * @param {string} [chatId]
   */
  function stop(sessionId, chatId) {
    for (const [key, turn] of running) {
      if (chatId === undefined ? key.startsWith(`${sessionId}\u0000`) : key === runKey(sessionId, chatId)) turn.stopped = true;
    }
    engine.abort(sessionId, chatId);
  }

  /**
   * The front end went away under its turns — a reload, a crash (#979). They
   * stop, and what was saved after their last finished step stays, marked as
   * cut off; nothing of them is written any more.
   *
   * @param {string|number} sessionId
   */
  function abandon(sessionId) {
    for (const [key, turn] of running) {
      if (key.startsWith(`${sessionId}\u0000`)) turn.abandoned = true;
    }
    engine.abort(sessionId);
  }

  /**
   * Lets the model name the chat once its first answer stands (#359). Runs
   * once per chat: afterwards the title is no longer the one derived from the
   * question. Older chats with a derived title are named on their next turn.
   *
   * @param {string} chatId
   * @returns {Promise<{ title: string|null }>}
   */
  async function nameChat(chatId) {
    const chat = typeof chatId === 'string' && chatId ? await history.load(chatId) : null;
    if (!chat) return { title: null };
    const source = titleSource(chat.messages);
    if (!source) return { title: null };
    // A German fallback stored before #359 still counts as "not named yet".
    if (!isDerivedChatTitle(chat.title, chat.messages.filter((m) => m && !m.isError))) return { title: null };
    const generated = await engine.generateTitle({
      messages: [
        { role: 'user', content: String(source.firstUser.content ?? '') },
        { role: 'assistant', content: String(source.firstAnswer.content ?? '') },
      ],
    });
    const title = 'title' in generated && typeof generated.title === 'string' ? generated.title.trim() : '';
    if (!title) return { title: null };
    // Deleted in the meantime: nothing is brought back.
    return { title: (await history.setTitle(chatId, title)) ? title : null };
  }

  /** Resolves once no chat is being named any more — for a quit, and for tests. */
  async function settled() {
    while (background.size > 0) await Promise.all([...background]);
  }

  return { sendTurn, runTurn, stop, abandon, nameChat, settled };
}

module.exports = { createConversationService, titleSource };
