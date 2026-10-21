'use strict';

/**
 * The stored conversation for the core's conversation service (#981). How a
 * chat is kept is `services/chat-history-service.js`'s business; this hands
 * on the operations the port names, typed against it.
 *
 * @param {Pick<ReturnType<typeof import('../services/chat-history-service').createChatHistoryService>,
 *   'load' | 'save' | 'addCost' | 'setTitle' | 'readAttachment'>} chatHistory
 * @returns {import('../../application/ports/chat-history-port').ChatHistoryPort}
 */
function createChatHistoryAdapter(chatHistory) {
  return {
    load: (chatId) => chatHistory.load(chatId),
    addCost: (chatId, cost) => chatHistory.addCost(chatId, cost),
    setTitle: (chatId, title) => chatHistory.setTitle(chatId, title),
    save: (chat, options) => chatHistory.save(chat, options),
    readAttachment: (chatId, file) => chatHistory.readAttachment(chatId, file),
  };
}

module.exports = { createChatHistoryAdapter };
