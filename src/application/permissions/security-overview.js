/**
 * The effective permission state of one workspace, for Settings › Security
 * (#448, concept §9 "One Security page per workspace").
 *
 * Pure: every input is data main has already read — the policy store, the
 * tool catalog, the sandbox, the session approvals, the chats of the folder.
 * The verdict per risk class comes from the same matrix `decideToolPolicy`
 * uses, so the page cannot tell a different story from the one that is
 * enforced. The renderer draws the result and decides nothing (concept §5).
 *
 * What a row says:
 *  - `off`   — no tool of the class is offered, or a block for every path
 *              stops all of them;
 *  - `runs`  — the mode lets the class run without asking;
 *  - `asks`  — otherwise. Allowances, remembered commands and session
 *              approvals are listed as exceptions: they cover single paths,
 *              commands or chats, never the class as a whole.
 */
'use strict';

const {
  TOOL_RISK_CLASSES,
  TOOL_RISK_CLASS_ORDER,
  TOOL_PERMISSION_MODES,
  POLICY_DECISIONS,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  normalizeToolPermissionMode,
  isCommandRule,
} = require('../../shared/contracts/tool-permissions');
const {
  DEFAULT_SENSITIVE_NAME_PATTERNS,
  DEFAULT_SENSITIVE_DIRECTORY_NAMES,
} = require('../../shared/runtime/sensitive-paths');
const { matrixDecision } = require('./tool-policy');

const SECURITY_ROW_STATUSES = Object.freeze({
  RUNS: 'runs',
  ASKS: 'asks',
  OFF: 'off',
});

const SECURITY_OFF_REASONS = Object.freeze({
  NO_TOOLS: 'no-tools',
  BLOCKED: 'blocked',
});

const { READ, READ_SENSITIVE, WRITE, DELETE, EXECUTE, EXTERNAL } = TOOL_RISK_CLASSES;

/**
 * The rows a tool shows up in. Its declared classes, plus what a call can
 * turn into: every reading tool can hit a sensitive path, and a tool that
 * overwrites can lose a file for good. An MCP tool is declared `execute` and
 * `external`; it belongs to the services it talks to, so it is shown there
 * (and under overwrite when its server says it deletes).
 */
function rowsOfTool(tool) {
  const declared = new Set(tool.riskClasses);
  if (tool.mcpServer) {
    const rows = new Set([EXTERNAL]);
    if (declared.has(DELETE)) rows.add(DELETE);
    return rows;
  }
  const rows = new Set(declared);
  if (declared.has(READ)) rows.add(READ_SENSITIVE);
  if (tool.mayOverwrite) rows.add(DELETE);
  return rows;
}

function cleanTools(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name)
    .map((tool) => {
      const available = tool.available !== false;
      const disabled = tool.disabled === true;
      return {
        name: tool.name,
        shortDescription: typeof tool.shortDescription === 'string' ? tool.shortDescription : '',
        riskClasses: Array.isArray(tool.riskClasses) ? tool.riskClasses.filter((cls) => TOOL_RISK_CLASS_ORDER.includes(cls)) : [],
        mayOverwrite: tool.mayOverwrite === true,
        mcpServer: typeof tool.mcpServer === 'string' && tool.mcpServer ? tool.mcpServer : null,
        // Why a tool is not offered matters for what the user does next:
        // switched off → switch it on; unavailable → set it up (a key, the
        // execution switch, a server).
        state: disabled ? 'disabled' : available ? 'on' : 'unavailable',
      };
    });
}

function ruleView(rule) {
  const view = {
    id: rule.id,
    effect: rule.effect,
    scope: rule.scope,
    tool: rule.tool || null,
    riskClass: rule.riskClass || null,
    pathPattern: rule.pathPattern,
  };
  if (isCommandRule(rule)) {
    view.command = rule.command;
    view.cwd = rule.cwd;
  }
  return view;
}

/** Does the rule name this row — by its class, or by one of its tools? */
function ruleNamesRow(rule, riskClass, toolNames) {
  if (rule.tool) return toolNames.has(rule.tool);
  return rule.riskClass === riskClass;
}

/**
 * A block for every path (`**`) that catches this tool in this row: named by
 * the tool, by the row's class or by one of the classes every call carries.
 */
function toolFullyBlocked(tool, riskClass, denyRules) {
  return denyRules.some(
    (rule) =>
      rule.pathPattern === '**' &&
      (rule.tool ? rule.tool === tool.name : rule.riskClass === riskClass || tool.riskClasses.includes(rule.riskClass))
  );
}

function cleanChats(raw, defaultMode) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((chat) => chat && typeof chat.id === 'string' && chat.id)
    .map((chat) => ({
      id: chat.id,
      title: typeof chat.title === 'string' ? chat.title.trim() : '',
      mode: normalizeToolPermissionMode(chat.mode),
      current: chat.current === true,
    }))
    .filter((chat) => chat.mode !== defaultMode);
}

function grantsForRow(grants, riskClass) {
  return grants.filter((grant) => Array.isArray(grant.classes) && grant.classes.includes(riskClass));
}

function describeExecution(execution, tools) {
  const source = execution && typeof execution === 'object' ? execution : {};
  const sandbox = source.sandbox && typeof source.sandbox === 'object' ? source.sandbox : null;
  const executionTools = tools.filter((tool) => !tool.mcpServer && tool.riskClasses.includes(EXECUTE));
  return {
    // Whether the sandbox matters right now; shown either way (#448: nothing
    // is hidden until needed).
    toolsOn: executionTools.some((tool) => tool.state === 'on'),
    sandbox: sandbox
      ? {
        status: typeof sandbox.status === 'string' ? sandbox.status : 'unknown',
        reason: typeof sandbox.reason === 'string' ? sandbox.reason : '',
        isolated: sandbox.isolated === true,
        platform: typeof sandbox.platform === 'string' ? sandbox.platform : '',
        missing: Array.isArray(sandbox.missing) ? sandbox.missing.filter((entry) => typeof entry === 'string') : [],
        detail: typeof sandbox.detail === 'string' ? sandbox.detail : '',
      }
      : null,
    workspaceSandboxDisabled: source.workspaceSandboxDisabled === true,
    unisolated: source.unisolated === true,
    pending: source.pending === true,
    programAllowances: Array.isArray(source.programAllowances) ? source.programAllowances : [],
  };
}

/**
 * @param {object} input
 * @param {string|null} input.root              the open workspace, or null
 * @param {string} input.mode                   the workspace default (#413); `smart` without a folder
 * @param {Array} [input.globalRules]
 * @param {Array} [input.workspaceRules]        rules of this root only
 * @param {Array} [input.tools]                 `listRiskCatalog()` plus `disabled`
 * @param {Array} [input.sessionGrants]         display DTOs of #447
 * @param {Array} [input.chats]                 `{ id, title, mode, current }` of this workspace
 * @param {object} [input.execution]            sandbox state, workspace switch, program allowances
 * @param {string[]} [input.sensitivePathPatterns]  the user's own patterns
 * @param {string} [input.integrity]
 * @param {boolean} [input.encryptionAvailable]
 */
function describeSecurityOverview(input = {}) {
  const root = typeof input.root === 'string' && input.root ? input.root : null;
  const mode = normalizeToolPermissionMode(input.mode);
  const tools = cleanTools(input.tools);
  const rules = [
    ...(Array.isArray(input.globalRules) ? input.globalRules : []),
    ...(root && Array.isArray(input.workspaceRules) ? input.workspaceRules : []),
  ].filter((rule) => rule && (rule.scope === PERMISSION_RULE_SCOPES.GLOBAL || (root && rule.root === root)));
  const denyRules = rules.filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY);
  const allowRules = rules.filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.ALLOW && !isCommandRule(rule));
  const commandRules = rules.filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.ALLOW && isCommandRule(rule));
  const grants = Array.isArray(input.sessionGrants) ? input.sessionGrants : [];
  // Allowances only save a question in "Smart"; "Always ask" passes them by
  // and "Auto" does not need them (tool-policy.js, steps 3–5).
  const allowancesApply = mode === TOOL_PERMISSION_MODES.SMART;

  const classes = TOOL_RISK_CLASS_ORDER.map((riskClass) => {
    const rowTools = tools.filter((tool) => rowsOfTool(tool).has(riskClass));
    const toolNames = new Set(rowTools.map((tool) => tool.name));
    const offered = rowTools.filter((tool) => tool.state === 'on');
    const running = offered.filter((tool) => !toolFullyBlocked(tool, riskClass, denyRules));
    const askFirst = matrixDecision(mode, riskClass) !== POLICY_DECISIONS.ALLOW;
    let status;
    let offReason = null;
    if (offered.length === 0) {
      status = SECURITY_ROW_STATUSES.OFF;
      offReason = SECURITY_OFF_REASONS.NO_TOOLS;
    } else if (running.length === 0) {
      status = SECURITY_ROW_STATUSES.OFF;
      offReason = SECURITY_OFF_REASONS.BLOCKED;
    } else {
      status = askFirst ? SECURITY_ROW_STATUSES.ASKS : SECURITY_ROW_STATUSES.RUNS;
    }
    return {
      riskClass,
      status,
      offReason,
      // What the mode does with a call of this class, whether or not a tool
      // is on right now — the answer to "does Snotra ask first?".
      askFirst,
      // Amber on the execute row: a command would run with the user's full
      // rights (#357, #396).
      noSandbox: riskClass === EXECUTE && status !== SECURITY_ROW_STATUSES.OFF && input.execution?.unisolated === true,
      tools: rowTools.map((tool) => ({ ...tool, blocked: tool.state === 'on' && toolFullyBlocked(tool, riskClass, denyRules) })),
      allowRules: allowRules.filter((rule) => ruleNamesRow(rule, riskClass, toolNames)).map(ruleView),
      denyRules: denyRules.filter((rule) => ruleNamesRow(rule, riskClass, toolNames)).map(ruleView),
      commandRules: riskClass === EXECUTE ? commandRules.map(ruleView) : [],
      sessionGrants: grantsForRow(grants, riskClass),
    };
  });

  return {
    workspace: root ? { root, name: workspaceName(root) } : null,
    defaultMode: mode,
    allowancesApply,
    integrity: typeof input.integrity === 'string' ? input.integrity : 'ok',
    encryptionAvailable: input.encryptionAvailable !== false,
    chatsWithOtherMode: root ? cleanChats(input.chats, mode) : [],
    classes,
    execution: describeExecution(input.execution, tools),
    sensitive: {
      builtInNames: [...DEFAULT_SENSITIVE_NAME_PATTERNS],
      builtInDirectories: [...DEFAULT_SENSITIVE_DIRECTORY_NAMES],
      userPatterns: Array.isArray(input.sensitivePathPatterns)
        ? input.sensitivePathPatterns.filter((pattern) => typeof pattern === 'string')
        : [],
    },
  };
}

/** The last segment of the root, for the header; the full path goes along. */
function workspaceName(root) {
  const trimmed = root.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

module.exports = {
  SECURITY_ROW_STATUSES,
  SECURITY_OFF_REASONS,
  rowsOfTool,
  describeSecurityOverview,
};
