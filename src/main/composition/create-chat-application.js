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
 *
 * @param {Object} deps
 * @param {import('../ports/llm-config-store-port').LlmConfigStorePort} deps.llmConfigStore
 * @param {import('../ports/provider-runtime-port').ProviderRuntimePort} deps.providerRuntime
 * @param {import('../ports/provider-secrets-port').ProviderSecretsPort} deps.providerSecrets
 * @param {import('../ports/ui-prefs-store-port').UiPrefsStorePort} deps.uiPrefsStore
 * @param {Parameters<typeof createWorkspaceToolAdapter>[0]} deps.toolRegistry
 * @param {Parameters<typeof createSkillsAdapter>[0]|null} deps.skillsService
 * @param {import('../../application/ports/environment-port').EnvironmentPort|null} [deps.environment]
 * @param {import('../../application/ports/project-instructions-port').ProjectInstructionsPort|null} [deps.projectInstructions]
 * @param {import('../../application/ports/rules-port').RulesPort|null} [deps.rules]
 * @param {import('../../application/ports/memory-port').MemoryPort|null} [deps.memory]
 * @param {typeof import('path')} deps.path
 * @param {number} [deps.maxToolRounds]
 * @param {Parameters<typeof createToolPolicyAdapter>[0]['toolPolicyStore']|null} [deps.toolPolicyStore]
 * @param {import('../../application/ports/tool-approval-port').ToolApprovalPort|null} [deps.approvals]
 * @param {ReturnType<typeof createSessionGrants>} [deps.sessionGrants]
 * @param {NonNullable<Parameters<typeof createWorkspaceToolAdapter>[1]>} [deps.toolAdapterDeps]
 * @param {(chatId: string) => string|null|Promise<string|null>} [deps.resolveChatMode]
 * @param {(chatId?: string) => Promise<string|null>} [deps.resolveReasoningLevel]
 * @param {(chatId?: string) => Promise<string|null>} [deps.resolveChatPreset]  the model entry of a chat off screen (#1194)
 * @param {(run: { sessionId: string|number, chatId: string|null }) => void} [deps.onRunStarted]
 * @param {(run: { sessionId: string|number, chatId: string|null }) => void} [deps.onRunSettled]
 * @param {import('../../application/ports/config-proposal-port').ConfigProposalPort|null} [deps.configProposals]
 * @param {Parameters<typeof createProviderLlmAdapter>[0]['modelPrices']} [deps.modelPrices]
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
  rules = null,
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
  resolveChatPreset = async () => null,
  // Called when a run ends, so that main can drop what only lived for it.
  onRunStarted = () => {},
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
    presetFor: resolveChatPreset,
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
    rules,
    toolPolicy,
    approvals,
    // The same list the tool results are compared against (§5), now also for
    // the skills, AGENTS.md and memory the prompt embeds (#528).
    ownSecrets: typeof toolAdapterDeps.readOwnSecrets === 'function'
      ? createOwnSecretsAdapter(toolAdapterDeps.readOwnSecrets)
      : null,
    sessionGrants,
    maxToolRounds,
    onRunStarted,
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
