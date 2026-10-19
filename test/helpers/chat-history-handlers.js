const { registerChatHistoryHandlers } = require('../../src/main/ipc/chat-history-handlers');
const { createChatHistoryService } = require('../../src/main/services/chat-history-service');

/**
 * Registers the chat history's channels the way the composition root does:
 * the service built from the same collaborators, the handlers on top (#1006).
 */
function registerChatHistoryForTest({ ipcMain, REQ, ...deps }) {
  const chatHistory = createChatHistoryService(deps);
  registerChatHistoryHandlers({ ipcMain, chatHistory, REQ });
  return chatHistory;
}

module.exports = { registerChatHistoryForTest };
