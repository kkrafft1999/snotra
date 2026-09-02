'use strict';

const { createChatEngine } = require('../../application/chat/chat-engine');
const { createProviderLlmAdapter } = require('../adapters/provider-llm-adapter');
const { createChatPreferencesAdapter } = require('../adapters/chat-preferences-adapter');
const { createNodeWorkspacePathAdapter } = require('../adapters/workspace-path-adapter');
const { createWorkspaceToolAdapter } = require('../adapters/workspace-tool-adapter');

function createChatApplication({
  llmConfigStore,
  providerRuntime,
  providerSecrets,
  uiPrefsStore,
  toolRegistry,
  path,
  maxToolRounds,
}) {
  const llm = createProviderLlmAdapter({ providerRuntime, llmConfigStore, providerSecrets });
  const tools = createWorkspaceToolAdapter(toolRegistry);
  const preferences = createChatPreferencesAdapter({ uiPrefsStore });
  const workspacePaths = createNodeWorkspacePathAdapter({ path });

  const engine = createChatEngine({
    llm,
    tools,
    preferences,
    workspacePaths,
    maxToolRounds,
  });

  return { engine, llm, tools, preferences, workspacePaths };
}

module.exports = {
  createChatApplication,
};
