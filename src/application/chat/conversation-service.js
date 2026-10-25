const { isDerivedChatTitle } = require('../../shared/contracts/chat');
const { CHAT_PROGRESS_TYPES } = require('../../shared/contracts/enums');
const { createMessage } = require('../../shared/contracts/message');
const { normalizeMessageOrigin } = require('../../shared/contracts/remote/message-origin');
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
 * @typedef {import('./turn-messages').EngineEvent} EngineEvent
 * @typedef {import('./turn-messages').ChatMessage} ChatMessage
 *
 * @typedef {Object} TurnInput
 * @property {string|number} sessionId  the front end's window or connection
 * @property {string} chatId
 * @property {{ content?: unknown, attachments?: unknown[], origin?: unknown }} message  the new question; attachments with their data,
 *   and where it came from when a remote front end asked (#1197)
 * @property {string|null} [workspaceRoot]
 * @property {string|null} [selectedPath]
 * @property {boolean} [selectedIsDirectory]
 * @property {(event: EngineEvent) => void} [onEvent]
 *
 * @typedef {Object} RunningTurn
 * @property {boolean} stopped    the user stopped it: it settles as far as it had come
 * @property {boolean} abandoned  its front end went away (#979): nothing more is written
 * @property {number} startedAt   when the question arrived, by the service's clock (#1254)
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
 * @param {() => number} [deps.now]  the clock a turn's duration is taken with (#1254)
 */
function createConversationService({ engine, history, describeError = (error) => String(error ?? ''), now = () => Date.now() }) {
  if (!engine || !history) throw new Error('createConversationService requires an engine and a chat-history port.');

  /** @type {Set<Promise<void>>} names still being made */
  const background = new Set();
  /**
   * Chats whose last save did not go through (#977): what they hold since, by
   * chat id. The next turn goes on from here rather than from the older copy
   * on disk, and its first save that goes through takes all of it along — as
   * when the renderer held the chat in memory.
   *
   * @type {Map<string, ChatMessage[]>}
   */
  const unsaved = new Map();
  /**
   * The latest turn of each chat, until it has saved for the last time: the
   * next turn in the same chat waits for it.
   *
   * @type {Map<string, { turn: RunningTurn, sessionId: string|number, finished: Promise<unknown>, done: boolean }>}
   */
  const lastTurn = new Map();
  /** @type {Map<string, RunningTurn>} the turns under way, by front end and chat */
  const running = new Map();
  /** @param {string|number} sessionId @param {string} chatId */
  const runKey = (sessionId, chatId) => `${sessionId}\u0000${chatId}`;

  /**
   * Adds the cost a run brought to the chat (#949) — a turn's, the name's or a
   * skill suggestion's (#1266). Undefined when there was none or it could not
   * be written: the reply then carries no sum, and the chat keeps the one it had.
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
  async function runTurn(input) {
    const { sessionId, chatId } = input;
    // The clock starts when the question arrives (#1254): waiting for the
    // turn before it to stop is part of what the user waits for.
    /** @type {RunningTurn} */
    const turn = { stopped: false, abandoned: false, startedAt: now() };
    const key = runKey(sessionId, chatId);
    // Known from the first moment: a stop pressed while the chat is still
    // being loaded must not be lost.
    running.set(key, turn);
    const previous = lastTurn.get(chatId);
    /** @type {() => void} */
    let finish = () => {};
    const finished = new Promise((resolve) => { finish = () => resolve(undefined); });
    const mine = { turn, sessionId, finished, done: false };
    lastTurn.set(chatId, mine);
    try {
      if (previous) {
        // A new turn in the same chat replaces one still going, as the engine
        // does: it is stopped and saved first, and this one goes on from what
        // it left — not from an older copy on disk.
        if (!previous.done) {
          previous.turn.stopped = true;
          engine.abort(previous.sessionId, chatId);
        }
        await previous.finished;
      }
      return await runOneTurn(input, turn, key);
    } finally {
      mine.done = true;
      finish();
      if (lastTurn.get(chatId) === mine) lastTurn.delete(chatId);
    }
  }

  /**
   * @param {TurnInput} input
   * @param {RunningTurn} turn
   * @param {string} key
   */
  async function runOneTurn({ sessionId, chatId, message, workspaceRoot = null, selectedPath = null, selectedIsDirectory = false, onEvent = () => {} }, turn, key) {
    const stored = await history.load(chatId);
    /** @type {ChatMessage} */
    const question = { role: 'user', content: typeof message?.content === 'string' ? message.content : '' };
    if (Array.isArray(message?.attachments) && message.attachments.length > 0) question.attachments = message.attachments;
    const origin = normalizeMessageOrigin(message?.origin);
    if (origin) question.origin = origin;
    /** @type {ChatMessage[]} */
    const asked = [...(unsaved.get(chatId) || stored?.messages || []), question];
    const answer = createTurnAnswer();
    // A stored chat stays under its folder; a new one goes under the open one.
    const base = stored ? { id: chatId, workspaceRoot: stored.workspaceRoot ?? null } : { id: chatId };

    /**
     * @param {ChatMessage[]} messages
     * @param {{ markActive?: boolean, tokenUsage?: unknown }} [options]
     */
    const save = async (messages, options = {}) => {
      if (turn.abandoned) return;
      // What the front end's banner says (#977): `unreadable` when main skipped
      // the save rather than write over a file it could not read (#473),
      // `failed` when the write itself went wrong, nothing otherwise.
      /** @type {{ ok: boolean, problem: 'unreadable'|'failed'|null }} */
      let saved;
      try {
        const outcome = await history.save({ ...base, messages, ...(options.tokenUsage ? { tokenUsage: options.tokenUsage } : {}) }, { markActive: options.markActive === true });
        saved = { ok: outcome?.ok === true, problem: outcome?.unreadable ? 'unreadable' : null };
      } catch (error) {
        console.error('[conversation] the chat was not saved:', error);
        saved = { ok: false, problem: 'failed' };
      }
      if (saved.problem) unsaved.set(chatId, messages);
      else if (saved.ok) unsaved.delete(chatId);
      onEvent(progressEvent(CHAT_PROGRESS_TYPES.CHAT_SAVED, saved));
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
      // Stopped before the engine had the turn: it never starts. From here on
      // the engine knows the run at once, and a stop reaches it.
      result = turn.stopped || turn.abandoned ? { cancelled: true, content: '', toolTrace: [] } : await engine.send({
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
    // Wall-clock time until the run ended (#1254), approval waits included;
    // the saves after it are not part of the answer.
    const durationMs = Math.max(0, now() - turn.startedAt);
    await writing;
    const chatCost = await addTurnCost(chatId, result);
    if (!turn.abandoned) {
      const settled = settleTurn(asked, answer, result, { describeError, stopped: turn.stopped, durationMs });
      const usage = result && typeof result === 'object' ? ('contextUsage' in result && result.contextUsage) || result.usage : null;
      await save(settled, { tokenUsage: usage || stored?.tokenUsage });
      // In the background: the name must not hold up the answer, and its
      // failure must not disturb the chat.
      const naming = nameChat(chatId).then(({ title, chatCost: namedCost }) => {
        if (title) onEvent(progressEvent(CHAT_PROGRESS_TYPES.CHAT_NAMED, { title, ...(namedCost ? { chatCost: namedCost } : {}) }));
      }, (error) => console.error('[conversation] the chat was not named:', error));
      background.add(naming);
      void naming.finally(() => background.delete(naming));
    }
    if (thrown) throw thrown;
    return { ...result, durationMs, ...(chatCost === undefined ? {} : { chatCost }) };
  }

  /**
   * The user stopped the turn of a chat (or every turn of the front end): it
   * settles as far as it had come.
   *
   * @param {string|number} sessionId
   * @param {string|null} [chatId]  undefined: every turn of the front end; null: the one without a chat (#532)
   */
  function stop(sessionId, chatId) {
    for (const [key, turn] of running) {
      if (chatId === undefined ? key.startsWith(`${sessionId}\u0000`) : chatId !== null && key === runKey(sessionId, chatId)) turn.stopped = true;
    }
    engine.abort(sessionId, chatId);
  }

  /**
   * Stops the turn of a chat, whichever front end started it (#1194): a
   * phone stops a turn begun at the desktop as well as its own
   * (`docs/remote-interface.md` §7.3). It settles as far as it had come.
   *
   * @param {string} chatId
   * @returns {boolean} whether a turn was under way
   */
  function stopChat(chatId) {
    const last = typeof chatId === 'string' && chatId ? lastTurn.get(chatId) : undefined;
    if (!last || last.done) return false;
    last.turn.stopped = true;
    engine.abort(last.sessionId, chatId);
    return true;
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
   * @returns {Promise<{ title: string|null, chatCost?: SessionCost }>}  the chat's new sum when the naming round cost something (#1266)
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
    // The round is paid whether or not it gave a name (#1266).
    const chatCost = await addTurnCost(chatId, generated);
    const withCost = (/** @type {{ title: string|null }} */ named) => (chatCost ? { ...named, chatCost } : named);
    const title = 'title' in generated && typeof generated.title === 'string' ? generated.title.trim() : '';
    if (!title) return withCost({ title: null });
    // Deleted in the meantime: nothing is brought back.
    return withCost({ title: (await history.setTitle(chatId, title)) ? title : null });
  }

  /** Resolves once no chat is being named any more — for a quit, and for tests. */
  async function settled() {
    while (background.size > 0) await Promise.all([...background]);
  }

  return { runTurn, stop, stopChat, abandon, nameChat, bookCost: addTurnCost, settled };
}

module.exports = { createConversationService, titleSource };
