'use strict';

/**
 * What the remote dispatcher reads of the desktop (#1194): the folders it
 * knows, the one that is open, the stored chats, which of them run or wait
 * for a card, and the activity the window's handlers publish.
 *
 * Read only, and nothing here goes through `chatHistory:activate`: a remote
 * that opens a chat never changes the one on the desktop's screen.
 */

const { createMessage } = require('../../shared/contracts/message');

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
 *   activity: { subscribe: import('../../application/ports/remote-desktop-port').RemoteDesktopPort['subscribe'] },
 * }} deps  `normalizeRoot` the chat history's, so that folders compare alike everywhere
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
  };
}

module.exports = { createRemoteDesktopAdapter };
