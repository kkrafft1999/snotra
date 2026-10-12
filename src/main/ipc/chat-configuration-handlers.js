'use strict';

/**
 * Which skills and tools the open chat has (#773), for the indicator at the
 * composer. Display only — the renderer names the skills its chat invoked
 * with "/name", and those count only where the catalogue has them; what the
 * chat switched on a card (#774) main knows itself.
 */
function registerChatConfigurationHandlers({
  ipcMain, chatConfiguration, getActiveWorkspaceRoot, getChatOverrides = async () => null, REQ,
}) {
  ipcMain.handle(REQ.CHAT_GET_CONFIGURATION, async (_event, request) => {
    const invoked = Array.isArray(request?.invokedSkills) ? request.invokedSkills : [];
    let overrides = null;
    try {
      overrides = await getChatOverrides();
    } catch {
      overrides = null;
    }
    return chatConfiguration.describe({
      workspaceRoot: typeof getActiveWorkspaceRoot === 'function' ? getActiveWorkspaceRoot() : null,
      chatSkillNames: invoked,
      // What this chat switched on a card (#774) comes from main, never from
      // the renderer.
      overrides,
    });
  });
}

module.exports = { registerChatConfigurationHandlers };
