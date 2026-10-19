'use strict';

/**
 * What the tool policy says, apart from where it is kept (#66, #1172): its
 * shape, how a file's content is normalised, and the fail-safe — what
 * survives a policy whose signature failed: only what tightens. Blocks,
 * patterns and "Always ask" stay; every allow rule, a switched-off sandbox,
 * a program allowance, a host kept open, the sandbox off for new workspaces
 * and a chat's confirmed "Auto" go (#357, #408, #413, #419, #946, #980, #1119).
 *
 * Signing, the key behind the secret store and the file itself are
 * `src/main/services/tool-policy-store.js`'s; so are the changes, each of
 * which needs a receipt of the user-confirmation port when it loosens.
 */

const {
  TOOL_PERMISSION_MODES,
  DEFAULT_TOOL_PERMISSION_MODE,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  normalizeToolPermissionMode,
  normalizePermissionRules,
  normalizeSensitivePathPatterns,
  isCommandRule,
} = require('../../shared/contracts/tool-permissions');
const { isRecord } = require('../../shared/runtime/is-record');
const { normalizeProgramAllowances } = require('../../shared/contracts/program-allowances');
const { grantedHosts } = require('../../shared/runtime/granted-hosts');

/** Hosts one workspace may keep open for its runs (#946). */
const MAX_WORKSPACE_HOSTS = 10;
/** Hosts kept open in every workspace (#1119). */
const MAX_GLOBAL_HOSTS = 10;
/**
 * Folders remembered as already there while new workspaces start without the
 * sandbox (#1119), the most recent last.
 */
const MAX_KNOWN_WORKSPACES = 1000;
/** Chats remembered as confirmed into "Auto" (#980) — as many as chat settings keep. */
const MAX_AUTO_CHATS = 500;

/**
 * What the policy file holds, after normalising.
 *
 * @typedef {import('../../shared/contracts/tool-permissions').PermissionRule} PermissionRule
 * @typedef {import('../../shared/contracts/tool-permissions').ToolPermissionMode} ToolPermissionMode
 * @typedef {import('../../shared/contracts/program-allowances').ProgramAllowance} ProgramAllowance
 * @typedef {(typeof import('../../shared/contracts/tool-permissions').TOOL_POLICY_INTEGRITY)[keyof typeof import('../../shared/contracts/tool-permissions').TOOL_POLICY_INTEGRITY]} PolicyIntegrity
 * @typedef {object} PolicyPayload
 * @property {number} revision
 * @property {ToolPermissionMode} mode
 * @property {PermissionRule[]} globalRules
 * @property {Record<string, PermissionRule[]>} workspaceRules
 * @property {string[]} sensitivePathPatterns
 * @property {string[]} unsandboxedWorkspaces
 * @property {ProgramAllowance[]} programAllowances
 * @property {Record<string, ProgramAllowance[]>} workspaceProgramAllowances
 * @property {Record<string, ToolPermissionMode>} workspaceModes
 * @property {Record<string, string[]>} workspaceHosts
 * @property {string[]} globalHosts
 * @property {boolean} newWorkspaceSandboxOff
 * @property {string[]} knownWorkspaces
 * @property {string[]} autoChats
 * @property {boolean} legacyWriteMigrated
 * @property {number} updatedAt
 */

/** @returns {PolicyPayload} */
function defaultPayload() {
  return {
    revision: 0,
    mode: DEFAULT_TOOL_PERMISSION_MODE,
    globalRules: [],
    workspaceRules: {},
    sensitivePathPatterns: [],
    unsandboxedWorkspaces: [],
    // Program allowances for every workspace (#408) — and, since #1119, per
    // workspace: root → entries.
    programAllowances: [],
    workspaceProgramAllowances: {},
    workspaceModes: {},
    workspaceHosts: {},
    globalHosts: [],
    // New workspaces start with the sandbox off (#1119); `knownWorkspaces` are
    // the folders that were there before, which keep their setting.
    newWorkspaceSandboxOff: false,
    knownWorkspaces: [],
    autoChats: [],
    legacyWriteMigrated: false,
    updatedAt: 0,
  };
}

/**
 * @param {unknown} chatId
 * @returns {string | null}
 */
function chatKey(chatId) {
  return typeof chatId === 'string' && chatId && chatId.length <= 200 ? chatId : null;
}

/**
 * Chat ids, each once, the most recent last (#980).
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeAutoChats(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of value) {
    const id = chatKey(entry);
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(-MAX_AUTO_CHATS);
}

/**
 * @param {string[]} list
 * @param {string} chatId
 * @returns {string[]}
 */
function withAutoChat(list, chatId) {
  return [...list.filter((id) => id !== chatId), chatId].slice(-MAX_AUTO_CHATS);
}

/**
 * Root → the hosts a connection card opened for that workspace (#946), in
 * the form the card offered them: `host:port` or `*.domain`. Anything a card
 * could not have offered is dropped, and so is a root without hosts.
 *
 * @param {unknown} value
 * @returns {Record<string, string[]>}
 */
function normalizeWorkspaceHosts(value) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [root, raw] of Object.entries(value)) {
    if (typeof root !== 'string' || !root) continue;
    const hosts = grantedHosts(raw).slice(0, MAX_WORKSPACE_HOSTS);
    if (hosts.length > 0) out[root] = hosts;
  }
  return out;
}

/**
 * Root → the program allowances of that workspace (#1119); a root without any is dropped.
 *
 * @param {unknown} value
 * @returns {Record<string, ProgramAllowance[]>}
 */
function normalizeWorkspaceProgramAllowances(value) {
  /** @type {Record<string, ProgramAllowance[]>} */
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [root, raw] of Object.entries(value)) {
    if (typeof root !== 'string' || !root) continue;
    const entries = normalizeProgramAllowances(raw);
    if (entries.length > 0) out[root] = entries;
  }
  return out;
}

/**
 * Root → `ask-all` | `auto`; `smart` and unknown values are no entry (#413).
 *
 * @param {unknown} value
 * @returns {Record<string, ToolPermissionMode>}
 */
function normalizeWorkspaceModes(value) {
  /** @type {Record<string, ToolPermissionMode>} */
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [root, raw] of Object.entries(value)) {
    if (typeof root !== 'string' || !root || typeof raw !== 'string') continue;
    const mode = normalizeToolPermissionMode(raw);
    if (mode !== raw || mode === DEFAULT_TOOL_PERMISSION_MODE) continue;
    out[root] = mode;
  }
  return out;
}

/**
 * Canonical roots only, each once; anything else is not a workspace (#357).
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeWorkspaceRoots(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameCommandRule(a, b) {
  return (
    isCommandRule(a) &&
    isCommandRule(b) &&
    a.root === b.root &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.networkDomains.join('\n') === b.networkDomains.join('\n')
  );
}

/**
 * @param {unknown} raw
 * @returns {PolicyPayload}
 */
function normalizePolicyPayload(raw) {
  /** @type {Record<string, unknown>} */
  const data = isRecord(raw) ? raw : {};
  const out = defaultPayload();
  out.revision = typeof data.revision === 'number' && Number.isInteger(data.revision) && data.revision >= 0 ? data.revision : 0;
  out.mode = normalizeToolPermissionMode(data.mode);
  out.globalRules = normalizePermissionRules(data.globalRules).filter(
    (rule) => rule.scope === PERMISSION_RULE_SCOPES.GLOBAL
  );
  out.workspaceRules = {};
  if (isRecord(data.workspaceRules)) {
    for (const [root, rules] of Object.entries(data.workspaceRules)) {
      if (typeof root !== 'string' || !root) continue;
      const normalized = normalizePermissionRules(rules).filter(
        (rule) => rule.scope === PERMISSION_RULE_SCOPES.WORKSPACE && rule.root === root
      );
      if (normalized.length > 0) out.workspaceRules[root] = normalized;
    }
  }
  out.sensitivePathPatterns = normalizeSensitivePathPatterns(data.sensitivePathPatterns);
  out.unsandboxedWorkspaces = normalizeWorkspaceRoots(data.unsandboxedWorkspaces);
  out.programAllowances = normalizeProgramAllowances(data.programAllowances);
  out.workspaceProgramAllowances = normalizeWorkspaceProgramAllowances(data.workspaceProgramAllowances);
  out.workspaceModes = normalizeWorkspaceModes(data.workspaceModes);
  out.workspaceHosts = normalizeWorkspaceHosts(data.workspaceHosts);
  out.globalHosts = grantedHosts(data.globalHosts).slice(0, MAX_GLOBAL_HOSTS);
  out.newWorkspaceSandboxOff = data.newWorkspaceSandboxOff === true;
  out.knownWorkspaces = normalizeWorkspaceRoots(data.knownWorkspaces).slice(-MAX_KNOWN_WORKSPACES);
  out.autoChats = normalizeAutoChats(data.autoChats);
  out.legacyWriteMigrated = data.legacyWriteMigrated === true;
  out.updatedAt = typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt) ? data.updatedAt : 0;
  return out;
}

/**
 * Fail-safe: only what tightens survives a failed check — blocks, patterns,
 * and "Always ask" as the mode (#419) or as a workspace default (#413).
 *
 * @param {unknown} payload
 * @returns {PolicyPayload}
 */
function failSafePayload(payload) {
  const out = normalizePolicyPayload(payload);
  if (out.mode !== TOOL_PERMISSION_MODES.ASK_ALL) out.mode = DEFAULT_TOOL_PERMISSION_MODE;
  out.globalRules = out.globalRules.filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY);
  for (const root of Object.keys(out.workspaceRules)) {
    out.workspaceRules[root] = out.workspaceRules[root].filter(
      (rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY
    );
    if (out.workspaceRules[root].length === 0) delete out.workspaceRules[root];
  }
  // A switched-off sandbox is a loosening like an allow rule (#357), and so
  // is a program allowance (#408).
  out.unsandboxedWorkspaces = [];
  out.programAllowances = [];
  out.workspaceProgramAllowances = {};
  // So is a host kept open for a workspace (#946) or for every one, the
  // sandbox off for new workspaces (#1119), and a chat's confirmed "Auto"
  // (#980).
  out.workspaceHosts = {};
  out.globalHosts = [];
  out.newWorkspaceSandboxOff = false;
  out.knownWorkspaces = [];
  out.autoChats = [];
  // "Auto" as a workspace default goes with them; "Always ask" only tightens
  // and stays, like a deny rule (#413).
  for (const [root, mode] of Object.entries(out.workspaceModes)) {
    if (mode !== TOOL_PERMISSION_MODES.ASK_ALL) delete out.workspaceModes[root];
  }
  return out;
}

/**
 * @param {PolicyPayload} payload
 * @param {PolicyIntegrity} integrity
 */
function policyVersionOf(payload, integrity) {
  return `${payload.revision}:${integrity}`;
}

/** @param {PolicyPayload} payload */
function allRules(payload) {
  const out = [...payload.globalRules];
  for (const rules of Object.values(payload.workspaceRules)) out.push(...rules);
  return out;
}

module.exports = {
  MAX_WORKSPACE_HOSTS,
  MAX_GLOBAL_HOSTS,
  MAX_KNOWN_WORKSPACES,
  MAX_AUTO_CHATS,
  defaultPayload,
  chatKey,
  normalizeAutoChats,
  withAutoChat,
  normalizeWorkspaceHosts,
  normalizeWorkspaceProgramAllowances,
  normalizeWorkspaceModes,
  normalizeWorkspaceRoots,
  sameCommandRule,
  normalizePolicyPayload,
  failSafePayload,
  policyVersionOf,
  allRules,
};
