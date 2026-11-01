// The chat history's channels. What a save keeps, which folder a chat belongs
// to and when the oldest go is decided in `services/chat-history-service.js`
// (#1006); these handlers only delegate. The renderer reads, deletes and
// points; it writes no chat — the conversation service does (#981).

/**
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {ReturnType<typeof import('../services/chat-history-service').createChatHistoryService>} deps.chatHistory
 * @param {Record<string, string>} deps.REQ
 */
function registerChatHistoryHandlers({ ipcMain, chatHistory, REQ }) {
  ipcMain.handle(REQ.CHAT_HISTORY_GET, async () => chatHistory.listForActiveFolder());

  ipcMain.handle(REQ.CHAT_HISTORY_GET_SESSION, async (_event, rawId) => ({
    session: await chatHistory.getSession(rawId),
  }));

  ipcMain.handle(REQ.CHAT_HISTORY_DELETE, async (_event, rawId) => chatHistory.deleteSession(rawId));

  ipcMain.handle(REQ.CHAT_HISTORY_SET_ACTIVE, async (_event, id) => chatHistory.setActive(id));

  ipcMain.handle(REQ.CHAT_HISTORY_ACTIVATE, async (_event, id, activation) => chatHistory.activate(id, activation));

  ipcMain.handle(REQ.CHAT_ATTACHMENT_READ, async (_event, chatId, file) => chatHistory.readAttachment(chatId, file));

  // The user's choice of a chat's kind (#1281): always the source `user`, whatever is sent along.
  ipcMain.handle(REQ.CHAT_HISTORY_SET_TASK_KIND, async (_event, chatId, kindId) => ({
    taskKind: await chatHistory.setTaskKind(chatId, { id: kindId, source: 'user' }),
  }));

  // *Keep* and *Assign to this folder* (#1320): the chat's id, and for *Keep* a boolean.
  ipcMain.handle(REQ.CHAT_HISTORY_SET_KEEP, async (_event, chatId, keep) => chatHistory.setKeep(chatId, keep));

  ipcMain.handle(REQ.CHAT_HISTORY_ASSIGN_TO_FOLDER, async (_event, chatId) => chatHistory.assignToActiveFolder(chatId));

  ipcMain.handle(REQ.CHAT_HISTORY_ASSIGN_ALL_TO_FOLDER, async (_event, oldRoot) => chatHistory.assignFolderToActiveFolder(oldRoot));
}

module.exports = { registerChatHistoryHandlers };
