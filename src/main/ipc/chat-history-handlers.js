// Chats sind nach Workspace gebucht. Welcher Workspace gerade aktiv ist,
// weiss der Main-Prozess (Issue #68) — der Renderer nennt ihn nicht mehr.
function registerChatHistoryHandlers({
  ipcMain,
  chatHistoryStore,
  REQ,
  getActiveWorkspaceRoot = () => null,
}) {
  ipcMain.handle(REQ.CHAT_HISTORY_GET, async () => {
    const store = await chatHistoryStore.readChatHistoryStore();
    const wsRoot = chatHistoryStore.normalizeWorkspaceRoot(getActiveWorkspaceRoot());
    const sessions = store.sessions
      .filter((s) => chatHistoryStore.sessionMatchesWorkspace(s, wsRoot))
      .map((s) => chatHistoryStore.normalizeSessionForLoad(s))
      .filter(Boolean);
    const activeChatId = store.activeByWorkspace[chatHistoryStore.workspaceBucketKey(wsRoot)] || null;
    return { sessions, activeChatId, workspaceRoot: wsRoot };
  });

  ipcMain.handle(REQ.CHAT_HISTORY_UPSERT, async (_event, sessionRow) =>
    chatHistoryStore.withChatHistoryLock(async () => {
      const store = await chatHistoryStore.readChatHistoryStore({ skipMigration: true });
      const existing =
        sessionRow && typeof sessionRow.id === 'string'
          ? store.sessions.find((x) => x.id === sessionRow.id.trim())
          : null;
      const titleProvided =
        typeof sessionRow?.title === 'string' && sessionRow.title.trim().length > 0;
      const normalized = chatHistoryStore.normalizeSessionForStore(
        { ...(sessionRow || {}), workspaceRoot: getActiveWorkspaceRoot() },
        {
          existingTitle: titleProvided ? undefined : existing?.title,
          requireMessages: true,
        }
      );
      if (!normalized) return { ok: false };
      const idx = store.sessions.findIndex((x) => x.id === normalized.id);
      if (idx >= 0) store.sessions[idx] = normalized;
      else store.sessions.push(normalized);
      store.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      if (store.sessions.length > chatHistoryStore.MAX_CHAT_SESSIONS) {
        const dropped = store.sessions.slice(chatHistoryStore.MAX_CHAT_SESSIONS);
        store.sessions = store.sessions.slice(0, chatHistoryStore.MAX_CHAT_SESSIONS);
        const droppedIds = new Set(dropped.map((s) => s.id));
        for (const [k, v] of Object.entries(store.activeByWorkspace)) {
          if (droppedIds.has(v)) delete store.activeByWorkspace[k];
        }
      }
      await chatHistoryStore.writeChatHistoryStore(store);
      return { ok: true };
    }));

  ipcMain.handle(REQ.CHAT_HISTORY_DELETE, async (_event, id) =>
    chatHistoryStore.withChatHistoryLock(async () => {
      if (typeof id !== 'string' || !id.trim()) return { ok: false };
      const store = await chatHistoryStore.readChatHistoryStore({ skipMigration: true });
      store.sessions = store.sessions.filter((s) => s.id !== id);
      for (const [k, v] of Object.entries(store.activeByWorkspace)) {
        if (v === id) delete store.activeByWorkspace[k];
      }
      await chatHistoryStore.writeChatHistoryStore(store);
      return { ok: true };
    }));

  ipcMain.handle(REQ.CHAT_HISTORY_SET_ACTIVE, async (_event, id) =>
    chatHistoryStore.withChatHistoryLock(async () => {
      const store = await chatHistoryStore.readChatHistoryStore({ skipMigration: true });
      const wsKey = chatHistoryStore.workspaceBucketKey(
        chatHistoryStore.normalizeWorkspaceRoot(getActiveWorkspaceRoot())
      );
      if (id === null || id === undefined || id === '') {
        delete store.activeByWorkspace[wsKey];
      } else if (typeof id === 'string') {
        store.activeByWorkspace[wsKey] = id;
      }
      await chatHistoryStore.writeChatHistoryStore(store);
      return { ok: true };
    }));
}

module.exports = { registerChatHistoryHandlers };
