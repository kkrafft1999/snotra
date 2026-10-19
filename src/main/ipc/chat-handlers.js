const { CHAT_ENGINE_EVENTS } = require('../../application/chat/chat-engine');
const { sanitizeChatId, createRunEndEvent } = require('../../shared/contracts/chat');

/**
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {Pick<ReturnType<typeof import('../../application/chat/chat-engine').createChatEngine>,
 *   'send' | 'abort' | 'generateTitle'>} deps.chatEngine
 * @param {Record<string, string>} deps.REQ
 * @param {Record<string, string>} deps.PUSH
 * @param {() => string|null} [deps.getActiveWorkspaceRoot]
 * @param {Pick<ReturnType<typeof import('../services/file-change-recorder').createFileChangeRecorder>, 'describe'>|null} [deps.fileChangeRecorder]
 */
function registerChatHandlers({
  ipcMain,
  chatEngine,
  REQ,
  PUSH,
  getActiveWorkspaceRoot = () => null,
  fileChangeRecorder = null,
}) {
  const engine = chatEngine;

  /** @type {Record<string, string>} */
  const eventChannels = {
    [CHAT_ENGINE_EVENTS.DELTA]: PUSH.CHAT_DELTA,
    [CHAT_ENGINE_EVENTS.TOOL_LINE]: PUSH.CHAT_TOOL_LINE,
    [CHAT_ENGINE_EVENTS.PROGRESS]: PUSH.CHAT_PROGRESS,
  };

  // Every event names its chat and its run (#320): a window can now have
  // several runs going, and the renderer routes each event to the chat it
  // belongs to — also when that chat is not on screen.
  /**
   * @param {import('electron').WebContents} webContents
   * @param {{ type?: string, payload?: unknown }} event
   * @param {{ chatId: string|null, runId: string|null }} route
   */
  const forwardEvent = (webContents, event, route) => {
    const channel = event?.type ? eventChannels[event.type] : undefined;
    if (!channel || !webContents || webContents.isDestroyed() || typeof webContents.send !== 'function') return;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    webContents.send(channel, { ...payload, ...route });
  };

  // A renderer that reloads, navigates or dies has lost the chats its runs
  // write into (#979): nobody would see their steps or answer their cards,
  // and the reloaded page cannot pick them up again. Their runs stop. The
  // turn up to its last finished step is already saved, marked as cut off.
  // Watched from a window's first send on, once per window.
  /** @type {WeakSet<import('electron').WebContents>} */
  const watched = new WeakSet();
  /** @param {import('electron').WebContents} webContents */
  const watchSender = (webContents) => {
    if (!webContents || watched.has(webContents) || typeof webContents.on !== 'function') return;
    watched.add(webContents);
    const sessionId = webContents.id;
    const stopRuns = () => engine.abort(sessionId);
    webContents.on('did-start-navigation', (details) => {
      if (details?.isMainFrame !== false && !details?.isSameDocument) stopRuns();
    });
    webContents.on('render-process-gone', stopRuns);
    webContents.once?.('destroyed', stopRuns);
  };

  // Stops the run of the named chat only; without one, every run of the window.
  // An id that is given but not usable names the run without a chat, as it
  // does on send (#532) — it does not widen the stop to the whole window.
  ipcMain.on(REQ.CHAT_ABORT, (event, payload) => {
    const chatId = payload?.chatId == null ? undefined : sanitizeChatId(payload.chatId);
    engine.abort(event.sender.id, chatId);
  });

  // The renderer names changes by the ids main gave it; it gets back the
  // lines, never a path it could choose itself (#348).
  ipcMain.handle(REQ.CHAT_FILE_CHANGES, async (_event, payload) => {
    if (!fileChangeRecorder) return { ok: false, reason: 'unknown' };
    const ids = Array.isArray(payload?.ids) ? payload.ids.filter((/** @type {unknown} */ id) => typeof id === 'string') : [];
    return fileChangeRecorder.describe(ids);
  });

  ipcMain.handle(REQ.CHAT_TITLE, async (_event, payload) => {
    return engine.generateTitle({ messages: payload?.messages });
  });

  // Der Workspace-Root kommt aus dem Main-Prozess, nicht aus dem Payload
  // (Issue #68). Die Nutzlast wird feldweise uebernommen, damit der Renderer
  // auch nichts anderes an der Engine vorbeischmuggeln kann.
  ipcMain.handle(REQ.CHAT_SEND, async (event, payload) => {
    // Nur ein Geltungsbereich fuer Sitzungsfreigaben (Issue #66), keine
    // Rechtequelle: ein anderer Chat teilt keine Freigaben.
    // The same rule as in the engine (#532), so that the events carry the id
    // the run is keyed by.
    const chatId = sanitizeChatId(payload?.chatId);
    // The renderer's own label for this turn; it only ever comes back to it.
    const runId = sanitizeRouteId(payload?.runId, 64);
    const route = { chatId, runId };
    watchSender(event.sender);
    try {
      return await engine.send({
        sessionId: event.sender.id,
        payload: {
          messages: payload?.messages,
          workspaceRoot: getActiveWorkspaceRoot(),
          selectedPath: payload?.selectedPath ?? null,
          selectedIsDirectory: payload?.selectedIsDirectory === true,
          chatId,
        },
        onEvent: (/** @type {{ type?: string, payload?: unknown }} */ engineEvent) => forwardEvent(event.sender, engineEvent, route),
      });
    } finally {
      // The reply to this invoke and the events above take different paths
      // to the renderer, and the reply can arrive first (#721). The end
      // marker takes the events' path: behind it, nothing of this run is
      // still on its way.
      forwardEvent(event.sender, { type: CHAT_ENGINE_EVENTS.PROGRESS, payload: createRunEndEvent() }, route);
    }
  });
}

/**
 * @param {unknown} raw
 * @param {number} maxLength
 */
function sanitizeRouteId(raw, maxLength) {
  return typeof raw === 'string' && raw ? raw.slice(0, maxLength) : null;
}

module.exports = {
  registerChatHandlers,
};
