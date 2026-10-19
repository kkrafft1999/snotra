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

const { DEFAULT_REASONING_LEVEL } = require('../../shared/contracts/reasoning');
const { CHAT_ACTIVATION, sanitizeChatId } = require('../../shared/contracts/chat');
const { CHAT_HISTORY_UNREADABLE } = require('../services/chat-history-store');

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
  // A tool's category from its descriptor, for entries stored before they
  // carried one (#1008).
  toolCategoryOf = () => null,
  // Der Zeitstempel eines Chats entsteht seit Issue #245 hier, nicht im
  // Renderer. Einspeisbar, damit Tests eine Reihenfolge festlegen koennen.
  now = () => Date.now(),
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
  /**
   * The history file is there but could not be read (#473), so the store
   * refuses to write its empty stand-in over it. The chat goes on in memory
   * and this one save is skipped — the new chat or the folder switch that
   * asked for it must not fail over it. `unreadable` tells the renderer that
   * nothing was saved, so it can say so in the chat (#977).
   */
  async function skipWhenUnreadable(run) {
    try {
      return await run();
    } catch (error) {
      if (error?.code !== CHAT_HISTORY_UNREADABLE) throw error;
      return { ok: false, unreadable: true };
    }
  }

  async function bucketKeyForSession(id) {
    const session = typeof id === 'string' ? await chatHistoryStore.getSessionMeta(id) : null;
    const root = session
      ? chatHistoryStore.normalizeWorkspaceRoot(session.workspaceRoot)
      : chatHistoryStore.normalizeWorkspaceRoot(getActiveWorkspaceRoot());
    return chatHistoryStore.workspaceBucketKey(root);
  }

  // The list carries no messages (#985): every chat of the folder with what
  // its row shows, and which one the folder opens with. A chat's messages
  // come with CHAT_HISTORY_GET_SESSION when it is opened.
  ipcMain.handle(REQ.CHAT_HISTORY_GET, async () => {
    const wsRoot = chatHistoryStore.normalizeWorkspaceRoot(getActiveWorkspaceRoot());
    const sessions = (await chatHistoryStore.listSessions())
      .filter((s) => chatHistoryStore.sessionMatchesWorkspace(s, wsRoot))
      .map((s) => chatHistoryStore.normalizeSessionMetaForList(s))
      .filter(Boolean);
    const activeChatId = await chatHistoryStore.getActiveChatId(chatHistoryStore.workspaceBucketKey(wsRoot));
    return { sessions, activeChatId, workspaceRoot: wsRoot };
  });

  // One chat with its messages, as the list used to carry every chat (#985).
  // Only one of the active folder's — the same chats the list hands out (#68).
  ipcMain.handle(REQ.CHAT_HISTORY_GET_SESSION, async (_event, rawId) => {
    const id = sanitizeChatId(rawId);
    if (!id) return { session: null };
    const wsRoot = chatHistoryStore.normalizeWorkspaceRoot(getActiveWorkspaceRoot());
    const session = await chatHistoryStore.getSession(id);
    if (!session || !chatHistoryStore.sessionMatchesWorkspace(session, wsRoot)) return { session: null };
    return { session: chatHistoryStore.normalizeSessionForLoad(session, { toolCategoryOf }) };
  });

  ipcMain.handle(REQ.CHAT_HISTORY_UPSERT, async (_event, sessionRow) =>
    skipWhenUnreadable(() => chatHistoryStore.withChatHistoryLock(async () => {
      const sessionId = typeof sessionRow?.id === 'string' ? sessionRow.id.trim() : '';
      const existing = sessionId ? await chatHistoryStore.getSession(sessionId) : null;
      const titleProvided =
        typeof sessionRow?.title === 'string' && sessionRow.title.trim().length > 0;
      // Bilder zuerst auf die Platte, danach normalisieren: die Normalisierung
      // nimmt nur Datei-Referenzen an, Base64 kommt so gar nicht erst in die
      // Verlaufsdatei (Issue #94).
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
        // The reasoning level likewise (#725): main's word, never the
        // renderer's. A chat saved for the first time gets the default if
        // nothing was chosen: a row without a level is one from before #726,
        // which takes the level of its old entry when it comes on screen.
        reasoningEffort: existing ? existing.reasoningEffort : DEFAULT_REASONING_LEVEL,
        // What the chat switched for itself (#774) — accepted on a card in
        // main, never sent by the renderer.
        configOverrides: existing?.configOverrides,
        ...chatSessionSettings.valuesFor(sessionId),
      };
      const normalized = chatHistoryStore.normalizeSessionForStore(
        {
          ...(sessionRow || {}),
          messages,
          workspaceRoot: await resolveSessionWorkspaceRoot(sessionRow),
          ...sessionSettings,
          // The renderer sums the chat's cost (#949); a save that does not
          // carry it keeps the one already stored.
          cost: sessionRow?.cost === undefined ? existing?.cost : sessionRow.cost,
          // Was der Renderer als Zeitpunkt mitschickt, gilt nicht (Issue #245):
          // er schreibt die Session auch, wenn gar nichts gesprochen wurde —
          // beim Verlassen, beim Modellwechsel, beim nachgezogenen Titel. Den
          // Stempel setzt der Main gleich darunter, und nur fuer einen Zug.
          updatedAt: undefined,
        },
        {
          existingTitle: titleProvided ? undefined : existing?.title,
          requireMessages: true,
        }
      );
      if (!normalized) return { ok: false };
      const previousUpdatedAt = Number.isFinite(existing?.updatedAt) ? existing.updatedAt : null;
      normalized.updatedAt =
        previousUpdatedAt !== null && !chatHistoryStore.storedChatMessagesChanged(existing.messages, normalized.messages)
          ? previousUpdatedAt
          : now();
      // The store drops the oldest chats beyond MAX_CHAT_SESSIONS, with their
      // folder pointers.
      const { droppedIds } = await chatHistoryStore.saveSession(normalized);
      // Under the same lock: the images of the chats this save dropped go by
      // id. Everything else without a session is swept only while no history
      // lies moved aside next to this one — the folders may belong to its
      // chats, and the copy is kept so that it can be recovered (#565).
      for (const id of droppedIds) await chatAttachments.deleteChat(id);
      if (!(await chatHistoryStore.hasSetAsideChatHistory())) {
        await chatAttachments.pruneChats((await chatHistoryStore.listSessions()).map((s) => s.id));
      }
      return { ok: true };
    })));

  ipcMain.handle(REQ.CHAT_HISTORY_DELETE, async (_event, rawId) =>
    skipWhenUnreadable(() => chatHistoryStore.withChatHistoryLock(async () => {
      // One id for the list, the pointers, the folder and the settings (#567).
      const id = sanitizeChatId(rawId);
      if (!id) return { ok: false };
      // The chat's file, its entry and every folder pointer to it.
      await chatHistoryStore.deleteSession(id);
      await chatAttachments.deleteChat(id);
      chatSessionSettings.forget(id);
      return { ok: true };
    })));

  ipcMain.handle(REQ.CHAT_HISTORY_SET_ACTIVE, async (_event, id) =>
    skipWhenUnreadable(() => chatHistoryStore.withChatHistoryLock(async () => {
      const wsKey = await bucketKeyForSession(id);
      if (id === null || id === undefined || id === '') {
        await chatHistoryStore.setActiveChatId(wsKey, null);
      } else if (typeof id === 'string') {
        // A pointer that stays as it was is not written again (#1060, #564).
        await chatHistoryStore.setActiveChatId(wsKey, id);
      }
      return { ok: true };
    })));

  // Modell und Freigabemodus des Chats herstellen (Issue #211). Der Renderer
  // liefert nur die Kennung; welche Werte dahinterstehen, weiss der Main.
  ipcMain.handle(REQ.CHAT_HISTORY_ACTIVATE, async (_event, id, activation) => {
    const chatId = sanitizeChatId(id);
    // Only exactly `explicit` may bring a stored "Auto" back; a missing or
    // unknown value is the automatic restore (#567).
    const explicit = activation === CHAT_ACTIVATION.EXPLICIT;
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
