'use strict';

const { resolveChatTitle } = require('../../src/shared/contracts/chat');

/**
 * The history half of the renderer's API, as main answers it since #985: the
 * list carries no messages — a count and the title to show — and a chat's
 * messages come with `getChatSession` when it is opened. `sessions` are whole
 * chats in the form the renderer gets them; the list is derived from them.
 * Pass a getter to have the list follow a test that changes the chats.
 */
function fakeChatHistoryApi(sessions, { activeChatId = null } = {}) {
  const current = () => (typeof sessions === 'function' ? sessions() : sessions) || [];
  const active = () => (typeof activeChatId === 'function' ? activeChatId() : activeChatId);
  return {
    getChatHistory: async () => ({
      sessions: current().map((session) => {
        const messages = Array.isArray(session.messages) ? session.messages : [];
        const row = {
          id: session.id,
          workspaceRoot: session.workspaceRoot ?? null,
          title: resolveChatTitle(session.title, messages),
          updatedAt: session.updatedAt,
          messageCount: messages.length,
        };
        if (session.cost) row.cost = session.cost;
        return row;
      }),
      activeChatId: active(),
    }),
    getChatSession: async (id) => ({ session: current().find((session) => session.id === id) || null }),
  };
}

module.exports = { fakeChatHistoryApi };
