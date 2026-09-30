import { t, tPlural, tMessage, getLocale } from '../i18n.js';
import { modeLabel, riskClassLabel, describeRule } from './tool-approval-view.js';
import { describeSandboxStatus } from './sandbox-status-view.js';
import { programLabel, tildePath } from './program-allowance-view.js';

/**
 * Texts for Settings › Security (#448). Main has decided every verdict — runs,
 * asks, off, no sandbox — and hands it over in the overview DTO; this module
 * only puts it into words. Nothing here derives a permission.
 */

/** Catalog segment per risk class, for the class-specific texts. */
const CLASS_KEYS = Object.freeze({
  read: 'read',
  'read-sensitive': 'readSensitive',
  write: 'write',
  delete: 'delete',
  execute: 'execute',
  external: 'external',
});

/** The classes the one-sentence summary speaks about, in its order. */
const SUMMARY_CLASSES = Object.freeze(['read', 'write', 'execute', 'external']);

/** Where each setting is changed today; #449 moves the controls onto the page. */
export const SECURITY_LINK_TARGETS = Object.freeze({
  tools: { panel: 'tools', target: 'heading-tool-catalog' },
  python: { panel: 'tools', target: 'heading-python' },
  shell: { panel: 'tools', target: 'heading-shell' },
  sandbox: { panel: 'tools', target: 'heading-workspace-sandbox', fallback: 'heading-shell' },
  allowances: { panel: 'tools', target: 'heading-program-allowances', fallback: 'heading-shell' },
  webSearch: { panel: 'tools', target: 'heading-web-search' },
  rules: { panel: 'permissions', target: 'heading-tool-rules' },
  sensitive: { panel: 'permissions', target: 'heading-sensitive-paths' },
  grants: { panel: 'permissions', target: 'heading-session-grants' },
  mcp: { panel: 'mcp', target: 'heading-mcp-servers' },
});

function classKey(riskClass) {
  return CLASS_KEYS[riskClass] || 'read';
}

function joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  try {
    return new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(parts);
  } catch {
    return parts.join(', ');
  }
}

function rowOf(overview, riskClass) {
  return (overview?.classes || []).find((entry) => entry.riskClass === riskClass) || null;
}

/** "Change under Tools" — the target named by its section in the nav. */
export function linkLabel(key) {
  const target = SECURITY_LINK_TARGETS[key];
  return t('security.link', { place: t(`settings.nav.${target?.panel || 'tools'}`) });
}

/**
 * The header: which folder, the default mode, the chats that differ, and the
 * page in one sentence.
 */
export function describeSecurityHeader(overview) {
  const workspace = overview?.workspace || null;
  const chats = Array.isArray(overview?.chatsWithOtherMode) ? overview.chatsWithOtherMode : [];
  const shown = chats.slice(0, 3).map((chat) =>
    t('security.header.otherChat', {
      title: chat.title || t('chat.title.new'),
      mode: modeLabel(chat.mode),
    })
  );
  return {
    hasWorkspace: !!workspace,
    name: workspace?.name || '',
    root: workspace?.root || '',
    otherChats: shown,
    otherChatsMore: chats.length > shown.length ? tPlural('security.header.otherChats.more', chats.length - shown.length) : '',
    summary: describeSummary(overview),
  };
}

/** "In this workspace, Snotra reads without asking, asks before …". */
export function describeSummary(overview) {
  const clauses = [];
  for (const riskClass of SUMMARY_CLASSES) {
    const row = rowOf(overview, riskClass);
    if (!row) continue;
    let clause = t(`security.summary.${classKey(riskClass)}.${row.status}`);
    if (riskClass === 'execute' && row.status !== 'off') {
      clause += t(row.noSandbox ? 'security.summary.execute.noSandbox' : 'security.summary.execute.sandbox');
    }
    clauses.push(clause);
  }
  if (clauses.length === 0) return '';
  return t(overview?.workspace ? 'security.summary.lead' : 'security.summary.leadNoWorkspace', { clauses: joinList(clauses) });
}

function toolCountLabel(row) {
  if (row.riskClass === 'read-sensitive') return t('security.row.readSensitive.sub');
  const on = row.tools.filter((tool) => tool.state === 'on').length;
  return on === 0 ? t('security.row.noTools') : tPlural('security.row.toolCount', on);
}

function reasonText(row, mode, hasWorkspace) {
  if (row.status === 'off') {
    return t(row.offReason === 'blocked' ? 'security.reason.off.blocked' : 'security.reason.off.noTools');
  }
  if (row.status === 'runs') {
    if (mode === 'auto') return t('security.reason.runs.auto');
    return t(hasWorkspace ? 'security.reason.runs.smart' : 'security.reason.runs.smartNoWorkspace');
  }
  if (mode === 'ask-all') return t('security.reason.asks.askAll');
  return t(`security.reason.asks.${classKey(row.riskClass)}`);
}

/**
 * The quiet line of exceptions under the reason: allowances and remembered
 * commands (only where the mode uses them), session approvals, blocks.
 */
function exceptionParts(row, allowancesApply) {
  const parts = [];
  if (allowancesApply && row.status !== 'off') {
    if (row.allowRules.length > 0 && row.allowRules.length <= 2) {
      for (const rule of row.allowRules) parts.push(t('security.except.allow', { pattern: rule.pathPattern }));
    } else if (row.allowRules.length > 2) {
      parts.push(tPlural('security.except.allowCount', row.allowRules.length));
    }
    if (row.commandRules.length > 0) parts.push(tPlural('security.except.commands', row.commandRules.length));
  }
  if (row.sessionGrants.length > 0 && row.status !== 'off') {
    parts.push(tPlural('security.except.grants', row.sessionGrants.length));
  }
  const blocks = row.denyRules.filter((rule) => rule.pathPattern !== '**' || rule.tool);
  if (blocks.length > 0 && blocks.length <= 2 && row.offReason !== 'blocked') {
    for (const rule of blocks) {
      parts.push(rule.tool
        ? t('security.except.denyTool', { tool: rule.tool, pattern: rule.pathPattern })
        : t('security.except.deny', { pattern: rule.pathPattern }));
    }
  } else if (blocks.length > 2) {
    parts.push(tPlural('security.except.denyCount', blocks.length));
  }
  return parts;
}

function scopeLabel(scope) {
  return t(scope === 'workspace' ? 'security.scope.workspace' : 'security.scope.global');
}

function toolItem(tool) {
  let tag = scopeLabel('global');
  let muted = false;
  if (tool.blocked) {
    tag = t('security.tool.blocked');
    muted = true;
  } else if (tool.state === 'disabled') {
    tag = t('security.tool.disabled');
    muted = true;
  } else if (tool.state === 'unavailable') {
    tag = t('security.tool.unavailable');
    muted = true;
  }
  return { name: tool.name, label: tool.shortDescription || tool.name, tag, muted };
}

function describeMay(row) {
  const key = classKey(row.riskClass);
  let answer;
  if (row.status === 'off') {
    answer = t(row.offReason === 'blocked' ? 'security.a.may.blocked' : 'security.a.may.no');
  } else {
    answer = t('security.a.may.yes');
  }
  const links = [row.riskClass === 'external' ? 'webSearch' : 'tools'];
  if (row.riskClass === 'execute') links.splice(0, 1, 'shell', 'python');
  if (row.riskClass === 'external' || row.tools.some((tool) => tool.mcpServer)) links.push('mcp');
  return {
    question: t(`security.q.may.${key}`),
    answer,
    note: ['read-sensitive', 'delete'].includes(row.riskClass) ? t(`security.a.may.${key}.note`) : '',
    tools: row.riskClass === 'read-sensitive' ? [] : row.tools.map(toolItem),
    links: [...new Set(links)],
  };
}

function describeAsk(row, overview) {
  const mode = overview.defaultMode;
  let answer;
  if (!row.askFirst) {
    answer = t(mode === 'auto' ? 'security.a.ask.auto' : 'security.a.ask.smartRead');
  } else if (mode === 'ask-all') {
    answer = t('security.a.ask.askAll');
  } else {
    answer = t(`security.a.ask.smart.${classKey(row.riskClass)}`);
  }
  const allowances = [
    ...row.allowRules.map((rule) => {
      const view = describeRule(rule);
      return {
        code: rule.pathPattern === '**' ? '' : rule.pathPattern,
        label: rule.tool ? t('security.allow.tool', { tool: rule.tool }) : view?.subject || '',
        tag: scopeLabel(rule.scope),
        scope: rule.scope === 'workspace' ? 'workspace' : 'global',
      };
    }),
    ...row.commandRules.map((rule) => ({ code: rule.command, label: '', tag: scopeLabel('workspace'), scope: 'workspace' })),
  ];
  const grants = row.sessionGrants.map((grant) => ({
    text: tMessage(grant.scope) || t('settings.grants.fallback', { tool: grant.tool || '' }),
    tag: t(grant.current ? 'security.grant.current' : 'security.grant.background', {
      title: grant.chatTitle || t('chat.title.new'),
    }),
  }));
  const applies = overview.allowancesApply === true;
  return {
    question: t('security.q.ask'),
    answer,
    // Allowances save a question only in "Smart"; in the other modes they are
    // listed with that said, so that nobody reads them as running.
    allowancesHeading: allowances.length > 0 ? t(applies ? 'security.a.ask.allowed' : 'security.a.ask.unused', { mode: modeLabel(mode) }) : '',
    allowances,
    allowancesMuted: !applies,
    grantsHeading: grants.length > 0 ? t('security.a.ask.grants') : '',
    grants,
    links: grants.length > 0 ? ['rules', 'grants'] : ['rules'],
  };
}

function blocksOf(row) {
  return row.denyRules.map((rule) => ({
    code: rule.pathPattern === '**' ? '' : rule.pathPattern,
    label: rule.tool ? t('security.allow.tool', { tool: rule.tool }) : rule.pathPattern === '**' ? t('permissions.rule.allPaths') : '',
    tag: scopeLabel(rule.scope),
    scope: rule.scope === 'workspace' ? 'workspace' : 'global',
  }));
}

function describeExecuteReach(overview, { homeDir = '' } = {}) {
  const execution = overview.execution || {};
  const sandbox = execution.sandbox;
  let state;
  if (execution.workspaceSandboxDisabled && sandbox?.reason !== 'platform') {
    state = { kind: 'warning', text: t('security.a.where.execute.workspaceOff') };
  } else if (sandbox?.isolated) {
    state = { kind: 'isolated', text: t('security.a.where.execute.isolated') };
  } else if (!sandbox || sandbox.status === 'unknown' || sandbox.status === 'testing') {
    state = { kind: 'pending', text: t('security.a.where.execute.pending') };
  } else {
    state = { kind: 'warning', text: describeSandboxStatus(sandbox, true)?.text || t('security.a.where.execute.unavailable') };
  }
  return {
    inactive: execution.toolsOn ? '' : t('security.a.where.execute.inactive'),
    state,
    facts: state.kind === 'isolated'
      ? [t('security.a.where.execute.fact.write'), t('security.a.where.execute.fact.secrets'), t('security.a.where.execute.fact.network')]
      : [],
    allowancesHeading: t('security.a.where.execute.allowances'),
    allowances: (execution.programAllowances || []).map((entry) => ({
      text: describeAllowanceSentence(entry, homeDir),
      tag: scopeLabel('global'),
    })),
    allowancesEmpty: t('security.a.where.execute.allowancesEmpty'),
  };
}

/** "gh may also reach api.github.com and write in ~/.config/gh". */
function describeAllowanceSentence(entry, homeDir) {
  const facts = [];
  if (Array.isArray(entry?.domains) && entry.domains.length > 0) {
    facts.push(t('security.allowance.network', { domains: joinList(entry.domains) }));
  }
  if (Array.isArray(entry?.writePaths) && entry.writePaths.length > 0) {
    const folders = entry.writePaths.map((folder) => tildePath(folder, homeDir));
    facts.push(t('security.allowance.folders', { folders: joinList(folders) }));
  }
  if (entry?.trustd === true) facts.push(t('security.allowance.trustd'));
  return t('security.allowance.sentence', {
    program: programLabel(entry?.path),
    facts: facts.length > 0 ? joinList(facts) : t('security.allowance.nothing'),
  });
}

function describeExternalReach(row) {
  const facts = [];
  for (const tool of row.tools.filter((entry) => entry.state === 'on' && !entry.blocked)) {
    if (tool.mcpServer) facts.push(t('security.a.where.external.mcp', { server: tool.mcpServer, tool: tool.name }));
    else if (tool.name === 'web_search') facts.push(t('security.a.where.external.webSearch'));
    else if (tool.name === 'fetch_url') facts.push(t('security.a.where.external.fetchUrl'));
    else facts.push(t('security.a.where.external.other', { tool: tool.name }));
  }
  return [...new Set(facts)];
}

function describeWhere(row, overview, options) {
  const key = classKey(row.riskClass);
  const where = {
    question: t(`security.q.where.${key}`),
    answer: '',
    blocksHeading: '',
    blocks: blocksOf(row),
    links: [],
  };
  if (where.blocks.length > 0) where.blocksHeading = t('security.a.where.blocks');
  switch (row.riskClass) {
    case 'read':
      where.answer = t(overview.workspace ? 'security.a.where.read' : 'security.a.where.read.noWorkspace');
      // The rules link already stands under question 2; here only with blocks.
      where.links = where.blocks.length > 0 ? ['rules'] : [];
      break;
    case 'read-sensitive':
      where.answer = t('security.a.where.readSensitive');
      where.sensitive = {
        builtInHeading: t('security.a.where.readSensitive.builtIn'),
        builtIn: [
          ...(overview.sensitive?.builtInNames || []),
          ...(overview.sensitive?.builtInDirectories || []).map((name) => `${name}/`),
        ],
        userHeading: t('security.a.where.readSensitive.user'),
        user: overview.sensitive?.userPatterns || [],
        userEmpty: t('security.a.where.readSensitive.userEmpty'),
      };
      where.links = ['sensitive'];
      break;
    case 'write':
      where.answer = t(overview.workspace ? 'security.a.where.write' : 'security.a.where.write.noWorkspace');
      // The rules link already stands under question 2; here only with blocks.
      where.links = where.blocks.length > 0 ? ['rules'] : [];
      break;
    case 'delete':
      where.answer = t('security.a.where.delete');
      // The rules link already stands under question 2; here only with blocks.
      where.links = where.blocks.length > 0 ? ['rules'] : [];
      break;
    case 'execute':
      where.execute = describeExecuteReach(overview, options);
      where.links = ['sandbox', 'allowances'];
      break;
    case 'external': {
      const facts = describeExternalReach(row);
      where.answer = facts.length > 0 ? t('security.a.where.external') : t('security.a.where.external.none');
      where.facts = facts;
      where.note = t('security.a.where.external.provider');
      where.links = ['webSearch', 'mcp'];
      break;
    }
    default:
      break;
  }
  return where;
}

/** One row: the closed line and the three questions it opens to. */
export function describeSecurityRow(row, overview, options = {}) {
  const pill = {
    runs: { text: t('security.status.runs'), kind: 'runs' },
    asks: { text: t('security.status.asks'), kind: 'asks' },
    off: { text: t('security.status.off'), kind: 'off' },
  }[row.status] || { text: t('security.status.asks'), kind: 'asks' };
  return {
    riskClass: row.riskClass,
    name: riskClassLabel(row.riskClass),
    sub: toolCountLabel(row),
    reason: reasonText(row, overview.defaultMode, !!overview.workspace),
    exceptions: exceptionParts(row, overview.allowancesApply === true).join(' · '),
    pill,
    noSandbox: row.noSandbox === true ? t('security.status.noSandbox') : '',
    may: describeMay(row),
    ask: describeAsk(row, overview),
    where: describeWhere(row, overview, options),
  };
}
