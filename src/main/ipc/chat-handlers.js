const { CHAT_ENGINE_EVENTS, resolveToolRoundLimit } = require('../chat-engine');

function registerChatHandlers({
  ipcMain,
  chatEngine,
  REQ,
  PUSH,
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

  ipcMain.handle(REQ.CHAT_SEND, async (event, payload) => {
    return engine.send({
      sessionId: event.sender.id,
      payload,
      onEvent: (engineEvent) => forwardEvent(event.sender, engineEvent),
    });
  });
}

module.exports = {
  registerChatHandlers,
  resolveToolRoundLimit,
};
