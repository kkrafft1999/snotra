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
  createWorkspaceFolderStorePort,
};
