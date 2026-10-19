const { registerChatHistoryHandlers } = require('../../src/main/ipc/chat-history-handlers');
const { createChatHistoryService } = require('../../src/main/services/chat-history-service');

/**
 * A channel only tests register: a save with the history's rules, as the
 * conversation service makes it (#981). The renderer has no such channel.
 */
const SAVE_CHAT = 'test:chatHistory:save';

/**
 * Registers the chat history's channels the way the composition root does:
 * the service built from the same collaborators, the handlers on top (#1006).
 */
function registerChatHistoryForTest({ ipcMain, REQ, ...deps }) {
  const chatHistory = createChatHistoryService(deps);
  registerChatHistoryHandlers({ ipcMain, chatHistory, REQ });
  ipcMain.handle(SAVE_CHAT, async (_event, row) => chatHistory.saveSession(row));
  return chatHistory;
}

module.exports = { registerChatHistoryForTest, SAVE_CHAT };
