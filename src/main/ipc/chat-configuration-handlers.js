'use strict';

/**
 * Which skills and tools the open chat has (#773), for the indicator at the
 * composer. Display only — the renderer names the skills its chat invoked
 * with "/name", and those count only where the catalogue has them.
 */
function registerChatConfigurationHandlers({ ipcMain, chatConfiguration, getActiveWorkspaceRoot, REQ }) {
  ipcMain.handle(REQ.CHAT_GET_CONFIGURATION, async (_event, request) => {
    const invoked = Array.isArray(request?.invokedSkills) ? request.invokedSkills : [];
    return chatConfiguration.describe({
      workspaceRoot: typeof getActiveWorkspaceRoot === 'function' ? getActiveWorkspaceRoot() : null,
      chatSkillNames: invoked,
    });
  });
}

module.exports = { registerChatConfigurationHandlers };
