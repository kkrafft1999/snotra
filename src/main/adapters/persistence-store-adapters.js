'use strict';

function createLlmConfigStorePort(storage) {
  return {
    readLLMConfig: (...args) => storage.readLLMConfig(...args),
    writeLLMConfig: (...args) => storage.writeLLMConfig(...args),
    updateLLMConfig: (...args) => storage.updateLLMConfig(...args),
    resolveChatModelTarget: (...args) => storage.resolveChatModelTarget(...args),
    normalizePresetEntry: (...args) => storage.normalizePresetEntry(...args),
  };
}

function createUiPrefsStorePort(storage) {
  return {
    readUIPrefs: (...args) => storage.readUIPrefs(...args),
    updateUIPrefs: (...args) => storage.updateUIPrefs(...args),
  };
}

function createChatHistoryStorePort(storage) {
  return {
    MAX_CHAT_SESSIONS: storage.MAX_CHAT_SESSIONS,
    readChatHistoryStore: (...args) => storage.readChatHistoryStore(...args),
    writeChatHistoryStore: (...args) => storage.writeChatHistoryStore(...args),
    withChatHistoryLock: (...args) => storage.withChatHistoryLock(...args),
    normalizeSessionForStore: (...args) => storage.normalizeSessionForStore(...args),
    normalizeSessionForLoad: (...args) => storage.normalizeSessionForLoad(...args),
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
