// Chats sind nach Workspace gebucht. Welcher Workspace gerade aktiv ist,
// weiss der Main-Prozess (Issue #68) — der Renderer nennt ihn nicht mehr.
//
// Eine Ausnahme braucht es beim Ordnerwechsel (Issue #131): der Renderer
// sichert die laufende Konversation erst, wenn der neue Ordner im Main schon
// aktiv ist. Wuerde jede Session stur mit dem aktiven Root gestempelt, wanderte
// der Chat des alten Ordners in den neuen Bucket. Deshalb darf die Session den
// Root nennen, unter dem sie gefuehrt wurde — aber nur, wenn es ein bereits
// geoeffneter Ordner ist (`isKnownWorkspaceRoot`). Alles andere faellt auf den
// aktiven Root zurueck, die Vertrauensgrenze aus #68 bleibt unberuehrt.

const { CHAT_ACTIVATION } = require('../services/chat-session-settings');

/**
 * Ohne Anhang-Ablage verhaelt sich der Verlauf wie vor Issue #94: Bilddaten
 * landen nie in der Session-Datei, es gibt dann eben auch keine Datei daneben.
 */
const NO_ATTACHMENT_STORE = {
  persistMessages: async (_chatId, messages) => messages,
  readAttachment: async () => ({ ok: false }),
  deleteChat: async () => {},
  pruneChats: async () => {},
};

/**
 * Ohne Chat-Einstellungen (Tests, Minimalaufbau) verhaelt sich der Verlauf wie
 * vor Issue #211: Es wird nichts je Chat gemerkt und nichts hergestellt.
 */
const NO_CHAT_SESSION_SETTINGS = {
  activate: async () => ({}),
  valuesFor: () => ({}),
  forget: () => {},
};

function registerChatHistoryHandlers({
  ipcMain,
  chatHistoryStore,
  REQ,
  chatAttachments = NO_ATTACHMENT_STORE,
  getActiveWorkspaceRoot = () => null,
  isKnownWorkspaceRoot = async () => false,
  chatSessionSettings = NO_CHAT_SESSION_SETTINGS,
}) {
  async function resolveSessionWorkspaceRoot(sessionRow) {
    const activeRoot = getActiveWorkspaceRoot();
    if (!sessionRow || typeof sessionRow !== 'object' || !('workspaceRoot' in sessionRow)) {
      return activeRoot;
    }
    const claimed = chatHistoryStore.normalizeWorkspaceRoot(sessionRow.workspaceRoot);
    if (claimed === null) {
      // Ein ausdrueckliches `null` heisst „ohne Ordner gefuehrt“ und bekommt
      // den eigenen Bucket. Ein unbrauchbarer String ist dagegen kein Wunsch,
      // sondern ein Fehler — der landet beim aktiven Root.
      const raw = sessionRow.workspaceRoot;
      return typeof raw === 'string' && raw.trim() ? activeRoot : null;
    }
    if (claimed === chatHistoryStore.normalizeWorkspaceRoot(activeRoot)) return activeRoot;
    return (await isKnownWorkspaceRoot(claimed)) ? claimed : activeRoot;
  }

  // Welcher Bucket bekommt die aktive Chat-ID? Der der Session selbst — sonst
  // schriebe das `setActiveChatId` direkt nach dem Sichern (Issue #131) die
  // alte Konversation in den Bucket des neuen Ordners.
  function bucketKeyForSession(store, id) {
    const session = typeof id === 'string' ? store.sessions.find((s) => s.id === id) : null;
    const root = session
      ? chatHistoryStore.normalizeWorkspaceRoot(session.workspaceRoot)
      : chatHistoryStore.normalizeWorkspaceRoot(getActiveWorkspaceRoot());
    return chatHistoryStore.workspaceBucketKey(root);
  }
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
      // Bilder zuerst auf die Platte, danach normalisieren: die Normalisierung
      // nimmt nur Datei-Referenzen an, Base64 kommt so gar nicht erst in die
      // Verlaufsdatei (Issue #94).
      const sessionId = typeof sessionRow?.id === 'string' ? sessionRow.id.trim() : '';
      const messages = sessionId
        ? await chatAttachments.persistMessages(sessionId, sessionRow?.messages)
        : sessionRow?.messages;
      // Modell und Freigabemodus kommen ausschliesslich aus dem Main (Issue
      // #211). Was der Renderer dazu mitschickt, wird verworfen — sonst waere
      // er die Rechtequelle fuer „Auto“ (Konzept §5). Bekannt ist der zuletzt
      // gemerkte Wert, sonst der bereits gespeicherte.
      const sessionSettings = {
        modelPresetId: existing?.modelPresetId,
        toolPermissionMode: existing?.toolPermissionMode,
        ...chatSessionSettings.valuesFor(sessionId),
      };
      const normalized = chatHistoryStore.normalizeSessionForStore(
        {
          ...(sessionRow || {}),
          messages,
          workspaceRoot: await resolveSessionWorkspaceRoot(sessionRow),
          ...sessionSettings,
        },
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
      // Unter demselben Lock aufraeumen: Bilder von Chats, die es nicht mehr
      // gibt — aus dem Limit gefallen, von Hand geloescht oder Reste einer in
      // Quarantaene gestellten Verlaufsdatei.
      await chatAttachments.pruneChats(store.sessions.map((s) => s.id));
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
      await chatAttachments.deleteChat(id);
      chatSessionSettings.forget(id);
      return { ok: true };
    }));

  ipcMain.handle(REQ.CHAT_HISTORY_SET_ACTIVE, async (_event, id) =>
    chatHistoryStore.withChatHistoryLock(async () => {
      const store = await chatHistoryStore.readChatHistoryStore({ skipMigration: true });
      const wsKey = bucketKeyForSession(store, id);
      if (id === null || id === undefined || id === '') {
        delete store.activeByWorkspace[wsKey];
      } else if (typeof id === 'string') {
        store.activeByWorkspace[wsKey] = id;
      }
      await chatHistoryStore.writeChatHistoryStore(store);
      return { ok: true };
    }));

  // Modell und Freigabemodus des Chats herstellen (Issue #211). Der Renderer
  // liefert nur die Kennung; welche Werte dahinterstehen, weiss der Main.
  ipcMain.handle(REQ.CHAT_HISTORY_ACTIVATE, async (_event, id, activation) => {
    const chatId = typeof id === 'string' ? id.trim().slice(0, 128) : null;
    const explicit = activation !== CHAT_ACTIVATION.AUTO;
    const applied = await chatSessionSettings.activate(chatId, {
      activation: explicit ? CHAT_ACTIVATION.EXPLICIT : CHAT_ACTIVATION.AUTO,
    });
    return { ok: true, ...applied };
  });

  // Bilddaten eines gespeicherten Anhangs (Issue #94). Der Renderer fragt erst
  // beim Anzeigen — der gesamte Verlauf eines Ordners auf einmal waere zu viel.
  ipcMain.handle(REQ.CHAT_ATTACHMENT_READ, async (_event, chatId, file) => {
    if (typeof chatId !== 'string' || !chatId.trim()) return { ok: false };
    if (typeof file !== 'string' || !file) return { ok: false };
    return chatAttachments.readAttachment(chatId.trim(), file);
  });
}

module.exports = { registerChatHistoryHandlers };
