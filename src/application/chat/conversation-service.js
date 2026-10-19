const { isDerivedChatTitle } = require('../../shared/contracts/chat');

/**
 * The conversation around a turn (#981). The engine runs one turn; what that
 * turn means for the stored chat — its cost added to the chat's sum (#949),
 * the chat named after its first answer — is decided here, through the
 * chat-history port, so that no front end has to repeat it.
 *
 * @typedef {import('../ports/chat-history-port').ChatHistoryPort} ChatHistoryPort
 * @typedef {import('../ports/chat-history-port').StoredChatMessage} StoredChatMessage
 * @typedef {import('../../shared/contracts/cost').SessionCost} SessionCost
 * @typedef {Pick<ReturnType<typeof import('./chat-engine').createChatEngine>, 'send' | 'generateTitle'>} ConversationEngine
 * @typedef {Parameters<ConversationEngine['send']>[0]} TurnRequest
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
 * @param {object} deps
 * @param {ConversationEngine} deps.engine
 * @param {ChatHistoryPort} deps.history
 */
function createConversationService({ engine, history }) {
  if (!engine || !history) throw new Error('createConversationService requires an engine and a chat-history port.');

  /**
   * Runs a turn and adds what it cost to the chat (#949). The reply carries the
   * chat's new sum as `chatCost`; a turn that cost nothing carries none, and
   * the chat's sum stays what it was.
   *
   * @param {TurnRequest} request
   */
  async function sendTurn(request) {
    const result = await engine.send(request);
    const chatId = request?.payload?.chatId;
    const turnCost = result && typeof result === 'object' && 'cost' in result ? result.cost : null;
    if (!turnCost || typeof chatId !== 'string' || !chatId) return result;
    /** @type {SessionCost|null} */
    let chatCost;
    try {
      chatCost = await history.addCost(chatId, turnCost);
    } catch (error) {
      // The turn stands without its sum: the reply says so by carrying none,
      // and the chat keeps the sum it had. The error goes to main's log.
      console.error('[conversation] the turn\'s cost was not added:', error);
      return result;
    }
    return { ...result, chatCost };
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

  return { sendTurn, nameChat };
}

module.exports = { createConversationService, titleSource };
