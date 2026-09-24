'use strict';

const { createHash } = require('node:crypto');
const { normalizeToolPermissionMode } = require('../../shared/contracts/tool-permissions');
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
  // Called when a run ends, so that main can drop what only lived for it.
  onRunSettled = () => {},
}) {
  const llm = createProviderLlmAdapter({ providerRuntime, llmConfigStore, providerSecrets });
  const tools = createWorkspaceToolAdapter(toolRegistry, toolAdapterDeps);
  const preferences = createChatPreferencesAdapter({ uiPrefsStore });
  const workspacePaths = createNodeWorkspacePathAdapter({ path });
  const skills = skillsService ? createSkillsAdapter(skillsService) : null;
  const toolPolicy = toolPolicyStore
    ? {
        async read({ chatId = null } = {}) {
          const state = await toolPolicyStore.read();
          return {
            mode: modeForRun(state, chatId, resolveChatMode),
            rules: state.rules,
            sensitivePathPatterns: state.sensitivePathPatterns,
            policyVersion: state.policyVersion,
            rulesVersion: rulesVersionOf(state),
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
    environment,
    projectInstructions,
    memory,
    toolPolicy,
    approvals,
    sessionGrants,
    maxToolRounds,
    onRunSettled,
  });

  return {
    engine, llm, tools, preferences, workspacePaths, skills, environment, projectInstructions, memory,
    toolPolicy, sessionGrants,
  };
}

/**
 * A remembered chat mode only counts while the policy file is intact. On a
 * failed signature the store falls back to `smart` (concept §7), and a chat in
 * the background must not keep a looser mode past that.
 */
function modeForRun(state, chatId, resolveChatMode) {
  if (state.integrity !== 'ok' && state.integrity !== 'missing') return state.mode;
  if (!chatId) return state.mode;
  let remembered = null;
  try {
    remembered = resolveChatMode(chatId);
  } catch {
    remembered = null;
  }
  return normalizeToolPermissionMode(remembered || state.mode);
}

/**
 * Everything a session approval depends on apart from the mode: the rules, the
 * sensitive path patterns and the integrity state. The store's
 * `policyVersion` also moves when only the mode is written — which now happens
 * whenever another chat comes on screen (#320).
 */
function rulesVersionOf(state) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([state.integrity, state.rules, state.sensitivePathPatterns]));
  return hash.digest('hex').slice(0, 32);
}

module.exports = {
  createChatApplication,
};
