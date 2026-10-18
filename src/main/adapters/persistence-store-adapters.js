'use strict';

/**
 * @returns {import('../ports/llm-config-store-port').LlmConfigStorePort}
 */
function createLlmConfigStorePort(storage) {
  return {
    readLLMConfig: (...args) => storage.readLLMConfig(...args),
    writeLLMConfig: (...args) => storage.writeLLMConfig(...args),
    updateLLMConfig: (...args) => storage.updateLLMConfig(...args),
    resolveChatModelTarget: (...args) => storage.resolveChatModelTarget(...args),
    normalizePresetEntry: (...args) => storage.normalizePresetEntry(...args),
  };
}

/**
 * @returns {import('../ports/ui-prefs-store-port').UiPrefsStorePort}
 */
function createUiPrefsStorePort(storage) {
  return {
    readUIPrefs: (...args) => storage.readUIPrefs(...args),
    updateUIPrefs: (...args) => storage.updateUIPrefs(...args),
  };
}

/**
 * @returns {import('../ports/chat-history-store-port').ChatHistoryStorePort}
 */
function createChatHistoryStorePort(storage) {
  return {
    MAX_CHAT_SESSIONS: storage.MAX_CHAT_SESSIONS,
    listSessions: (...args) => storage.listChatSessions(...args),
    getSessionMeta: (...args) => storage.getChatSessionMeta(...args),
    getSession: (...args) => storage.getChatSession(...args),
    getActiveChatId: (...args) => storage.getActiveChatId(...args),
    saveSession: (...args) => storage.saveChatSession(...args),
    patchSession: (...args) => storage.patchChatSession(...args),
    deleteSession: (...args) => storage.deleteChatSession(...args),
    setActiveChatId: (...args) => storage.setActiveChatId(...args),
    withChatHistoryLock: (...args) => storage.withChatHistoryLock(...args),
    hasSetAsideChatHistory: (...args) => storage.hasSetAsideChatHistory(...args),
    storedChatMessagesChanged: (...args) => storage.storedChatMessagesChanged(...args),
    normalizeSessionForStore: (...args) => storage.normalizeSessionForStore(...args),
    normalizeSessionForLoad: (...args) => storage.normalizeSessionForLoad(...args),
    normalizeSessionMetaForList: (...args) => storage.normalizeSessionMetaForList(...args),
    normalizeWorkspaceRoot: (...args) => storage.normalizeWorkspaceRoot(...args),
    workspaceBucketKey: (...args) => storage.workspaceBucketKey(...args),
    sessionMatchesWorkspace: (...args) => storage.sessionMatchesWorkspace(...args),
  };
}

/** Schluessel des Web-Such-Dienstes (Issue #63) — eigene Datei, kein LLM-Anbieter. */
function createWebSearchStorePort(storage) {
  return {
    hasWebSearchApiKey: (...args) => storage.hasWebSearchApiKey(...args),
    getWebSearchApiKey: (...args) => storage.getWebSearchApiKey(...args),
    setWebSearchApiKey: (...args) => storage.setWebSearchApiKey(...args),
  };
}

/**
 * MCP-Serverliste fuer Oberflaeche und Handler (Issue #108). Bewusst OHNE die
 * entschluesselnden Zugriffe: was an den Renderer geht, soll gar nicht erst
 * die Moeglichkeit haben, an ein Geheimnis zu kommen.
 */
function createMcpConfigStorePort(storage) {
  return {
    readMcpServers: (...args) => storage.readMcpServers(...args),
    saveMcpServer: (...args) => storage.saveMcpServer(...args),
    deleteMcpServer: (...args) => storage.deleteMcpServer(...args),
    updateMcpServerKnownTools: (...args) => storage.updateMcpServerKnownTools(...args),
    clearMcpServerDisabledTools: (...args) => storage.clearMcpServerDisabledTools(...args),
  };
}

/**
 * Das entschluesselnde Gegenstueck — nur fuer den Dienst, der die Prozesse
 * startet, und fuer den Abgleich gegen Tool-Ausgaben (Konzept §5). Geht nie
 * an den Renderer.
 */
function createMcpSecretsPort(storage) {
  return {
    getMcpServersForRuntime: (...args) => storage.getMcpServersForRuntime(...args),
    getMcpSecretValues: (...args) => storage.getMcpSecretValues(...args),
  };
}

/**
 * @returns {import('../ports/workspace-folder-store-port').WorkspaceFolderStorePort}
 */
function createWorkspaceFolderStorePort(storage) {
  return {
    getValidatedLastFolder: (...args) => storage.getValidatedLastFolder(...args),
    persistLastFolder: (...args) => storage.persistLastFolder(...args),
    getValidatedFolderHistory: (...args) => storage.getValidatedFolderHistory(...args),
    removeFolderFromHistory: (...args) => storage.removeFolderFromHistory(...args),
  };
}

module.exports = {
  createLlmConfigStorePort,
  createUiPrefsStorePort,
  createChatHistoryStorePort,
  createWebSearchStorePort,
  createMcpConfigStorePort,
  createMcpSecretsPort,
  createWorkspaceFolderStorePort,
};
