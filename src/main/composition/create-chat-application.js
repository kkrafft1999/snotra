'use strict';

const { createChatEngine } = require('../../application/chat/chat-engine');
const { createSessionGrants } = require('../../application/permissions/session-grants');
const { createProviderLlmAdapter } = require('../adapters/provider-llm-adapter');
const { createChatPreferencesAdapter } = require('../adapters/chat-preferences-adapter');
const { createNodeWorkspacePathAdapter } = require('../adapters/workspace-path-adapter');
const { createWorkspaceToolAdapter } = require('../adapters/workspace-tool-adapter');
const { createSkillsAdapter } = require('../adapters/skills-adapter');

/**
 * Verdrahtet die Chat-Engine mit ihren Ports. Seit Issue #66 gehören dazu der
 * Policy-Port (signierter Berechtigungsstand), der Approval-Port (Karten im
 * Renderer) und die Sitzungsfreigaben. Fehlen Policy oder Freigaben (Tests,
 * Minimalaufbau), verhält sich die Engine fail-safe: Modus `smart`, jede
 * Rückfrage wird abgelehnt.
 */
function createChatApplication({
  llmConfigStore,
  providerRuntime,
  providerSecrets,
  uiPrefsStore,
  toolRegistry,
  skillsService,
  path,
  maxToolRounds,
  toolPolicyStore = null,
  approvals = null,
  sessionGrants = createSessionGrants(),
  toolAdapterDeps = {},
}) {
  const llm = createProviderLlmAdapter({ providerRuntime, llmConfigStore, providerSecrets });
  const tools = createWorkspaceToolAdapter(toolRegistry, toolAdapterDeps);
  const preferences = createChatPreferencesAdapter({ uiPrefsStore });
  const workspacePaths = createNodeWorkspacePathAdapter({ path });
  const skills = skillsService ? createSkillsAdapter(skillsService) : null;
  const toolPolicy = toolPolicyStore
    ? {
        async read() {
          const state = await toolPolicyStore.read();
          return {
            mode: state.mode,
            rules: state.rules,
            sensitivePathPatterns: state.sensitivePathPatterns,
            policyVersion: state.policyVersion,
            integrity: state.integrity,
            encryptionAvailable: state.encryptionAvailable,
          };
        },
      }
    : null;

  const engine = createChatEngine({
    llm,
    tools,
    preferences,
    workspacePaths,
    skills,
    toolPolicy,
    approvals,
    sessionGrants,
    maxToolRounds,
  });

  return { engine, llm, tools, preferences, workspacePaths, skills, toolPolicy, sessionGrants };
}

module.exports = {
  createChatApplication,
};
