'use strict';

const { createChatEngine } = require('../../application/chat/chat-engine');
const { createSessionGrants } = require('../../application/permissions/session-grants');
const { createProviderLlmAdapter } = require('../adapters/provider-llm-adapter');
const { createChatPreferencesAdapter } = require('../adapters/chat-preferences-adapter');
const { createNodeWorkspacePathAdapter } = require('../adapters/workspace-path-adapter');
const { createWorkspaceToolAdapter } = require('../adapters/workspace-tool-adapter');
const { createSkillsAdapter } = require('../adapters/skills-adapter');
const { createToolPolicyAdapter } = require('../adapters/tool-policy-adapter');
const { createOwnSecretsAdapter } = require('../adapters/own-secrets-adapter');

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
  environment = null,
  projectInstructions = null,
  memory = null,
  path,
  maxToolRounds,
  toolPolicyStore = null,
  approvals = null,
  sessionGrants = createSessionGrants(),
  toolAdapterDeps = {},
  // The mode of a chat that is running in the background (#320): the mode it
  // had while it was on screen. `null` means "the store's mode applies" —
  // always the case for the visible chat.
  resolveChatMode = () => null,
  // The chat's own reasoning level (#725); `null` when it has none.
  resolveReasoningLevel = async () => null,
  // Called when a run ends, so that main can drop what only lived for it.
  onRunSettled = () => {},
  // What a chat switched for itself, and the model's proposals (#774).
  configProposals = null,
  // Prices for the estimated chat cost (#949).
  modelPrices = null,
}) {
  const llm = createProviderLlmAdapter({
    providerRuntime,
    llmConfigStore,
    providerSecrets,
    reasoningLevelFor: resolveReasoningLevel,
    modelPrices,
  });
  const tools = createWorkspaceToolAdapter(toolRegistry, toolAdapterDeps);
  const preferences = createChatPreferencesAdapter({ uiPrefsStore });
  const workspacePaths = createNodeWorkspacePathAdapter({ path });
  const skills = skillsService ? createSkillsAdapter(skillsService) : null;
  const toolPolicy = toolPolicyStore ? createToolPolicyAdapter({ toolPolicyStore, resolveChatMode }) : null;

  const engine = createChatEngine({
    llm,
    tools,
    preferences,
    workspacePaths,
    skills,
    environment,
    projectInstructions,
    memory,
    toolPolicy,
    approvals,
    // The same list the tool results are compared against (§5), now also for
    // the skills, AGENTS.md and memory the prompt embeds (#528).
    ownSecrets: typeof toolAdapterDeps.readOwnSecrets === 'function'
      ? createOwnSecretsAdapter(toolAdapterDeps.readOwnSecrets)
      : null,
    sessionGrants,
    maxToolRounds,
    onRunSettled,
    configProposals,
  });

  return {
    engine, llm, tools, preferences, workspacePaths, skills, environment, projectInstructions, memory,
    toolPolicy, sessionGrants,
  };
}

module.exports = {
  createChatApplication,
};
