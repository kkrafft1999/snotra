const { CHAT_ENGINE_EVENTS, resolveToolRoundLimit } = require('../chat-engine');

function registerChatHandlers({
  ipcMain,
  chatEngine,
  REQ,
  PUSH,
  getActiveWorkspaceRoot = () => null,
}) {
  const engine = chatEngine;

  const eventChannels = {
    [CHAT_ENGINE_EVENTS.DELTA]: PUSH.CHAT_DELTA,
    [CHAT_ENGINE_EVENTS.TOOL_LINE]: PUSH.CHAT_TOOL_LINE,
    [CHAT_ENGINE_EVENTS.PROGRESS]: PUSH.CHAT_PROGRESS,
  };

  const forwardEvent = (webContents, event) => {
    const channel = eventChannels[event?.type];
    if (!channel || !webContents || webContents.isDestroyed() || typeof webContents.send !== 'function') return;
    webContents.send(channel, event.payload);
  };

  ipcMain.on(REQ.CHAT_ABORT, (event) => {
    engine.abort(event.sender.id);
  });

  ipcMain.handle(REQ.CHAT_TITLE, async (_event, payload) => {
    return engine.generateTitle({ messages: payload?.messages });
  });

  // Der Workspace-Root kommt aus dem Main-Prozess, nicht aus dem Payload
  // (Issue #68). Die Nutzlast wird feldweise uebernommen, damit der Renderer
  // auch nichts anderes an der Engine vorbeischmuggeln kann.
  ipcMain.handle(REQ.CHAT_SEND, async (event, payload) => {
    return engine.send({
      sessionId: event.sender.id,
      payload: {
        messages: payload?.messages,
        workspaceRoot: getActiveWorkspaceRoot(),
        selectedPath: payload?.selectedPath ?? null,
        selectedIsDirectory: payload?.selectedIsDirectory === true,
      },
      onEvent: (engineEvent) => forwardEvent(event.sender, engineEvent),
    });
  });
}

module.exports = {
  registerChatHandlers,
  resolveToolRoundLimit,
};
