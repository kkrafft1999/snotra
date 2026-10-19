'use strict';

/**
 * IPC für Tool-Berechtigungen (Issue #66, Konzept §5–§8).
 *
 * Der Renderer liest den Stand, stößt Änderungen an und beantwortet
 * Freigabe-Karten. Er ist keine Sicherheitsgrenze: Die drei Aktionen, die den
 * Schutz insgesamt lockern — Auto aktivieren, dauerhafte Allow-Regel anlegen,
 * Deny-Regel löschen — bestätigt der Main-Prozess in einem nativen Dialog
 * (`dialog.showMessageBox`), bevor er sie ausführt. Jede Änderung an Modus
 * oder Regeln verwirft offene Anfragen und Sitzungsfreigaben (Konzept §7).
 *
 * The fourth loosening is switching the sandbox off for a workspace (#357):
 * the same native confirmation, the root always taken from main.
 *
 * The fifth comes from the card itself (#121): "always allow this command in
 * this workspace" stores a command rule. The rule is the one main built from
 * the plan of the open request — the renderer only says "always" — and it is
 * confirmed natively like every other allow rule before it is stored.
 *
 * The seventh is "Auto" as the default mode of a workspace (#413): every new
 * chat there runs without asking, also after a restart. Main binds the active
 * root and names it in the dialog; "Smart" and "Always ask" need no dialog.
 *
 * The sixth is a program allowance (#408): extra rights inside the sandbox
 * for one program, in every workspace. Main resolves the program and checks
 * every folder itself, then confirms natively; an edit that only takes rights
 * away, and removing an allowance, need no confirmation.
 *
 * Since #980 every one of these asks through the user-confirmation port, not
 * the dialog itself: the desktop's adapter shows the native message box, and
 * its receipt is what the policy store accepts — a front end without a person
 * at the machine gets no receipt and loosens nothing.
 */

const {
  TOOL_PERMISSION_MODES,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  PERMISSION_DENIAL_REASONS,
  APPROVAL_RESPONSES,
  PERSISTENT_ALLOW_CLASSES,
  normalizeToolPermissionMode,
  normalizePermissionRule,
  normalizeSensitivePathPatterns,
  normalizeToolApprovalResponse,
} = require('../../shared/contracts/tool-permissions');
const { createSettingsOk, createSettingsError } = require('../../shared/contracts/settings');
const { createMessage } = require('../../shared/contracts/message');
const { createTranslator } = require('../../shared/i18n');
const { menuPath } = require('../../shared/i18n/ui-quotes');
const { isNarrowing, normalizeAllowancePath } = require('../../shared/contracts/program-allowances');
const { grantedHosts } = require('../services/sandbox-violations');
const { describeSecurityOverview } = require('../../application/permissions/security-overview');
const { resolvePlatform } = require('../platforms');
const {
  CONFIRMATION_ACTIONS,
  permissionRuleSubject,
  removedPatternsSubject,
  programAllowanceSubject,
  globalHostsSubject,
  createRefusingConfirmation,
} = require('../../application/permissions/user-confirmation');

// The three dialogs are built for the language the interface speaks at the
// moment they open (#353). They live only until the click, so there is nothing
// to repaint on a language change.
function autoModeDialog(t) {
  return {
    type: 'warning',
    title: t('permissionDialog.auto.title'),
    message: t('permissionDialog.auto.title'),
    detail: t('permissionDialog.auto.detail'),
    buttons: [t('permissionDialog.auto.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

function ruleSubject(rule, t) {
  return rule.tool
    ? t('permissionDialog.subject.tool', { tool: rule.tool })
    : t('permissionDialog.subject.class', { riskClass: rule.riskClass });
}

function allowRuleDialog(rule, t) {
  const scope = rule.scope === PERMISSION_RULE_SCOPES.GLOBAL
    ? t('permissionDialog.scope.global')
    : t('permissionDialog.scope.workspace', { root: rule.root });
  return {
    type: 'warning',
    title: t('permissionDialog.allowRule.title'),
    message: t('permissionDialog.allowRule.title'),
    detail: t('permissionDialog.allowRule.detail', {
      subject: ruleSubject(rule, t),
      pattern: rule.pathPattern,
      scope,
      // Mode and page are quoted from the entries the interface renders, so
      // that the dialog names what the user will actually find.
      mode: t('permissions.mode.smart'),
      place: menuPath(t.locale, 'settings.security'),
    }),
    buttons: [t('permissionDialog.allowRule.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

function removeDenyRuleDialog(rule, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.removeDeny.title'),
    message: t('permissionDialog.removeDeny.title'),
    detail: t('permissionDialog.removeDeny.detail', { subject: ruleSubject(rule, t), pattern: rule.pathPattern }),
    buttons: [t('permissionDialog.removeDeny.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * What a reset or a shorter pattern list takes away that protects (#514):
 * blocks, the user's sensitive path patterns, "Always ask" as a default or as
 * the mode on screen. Removing those is a loosening like deleting one deny
 * rule, so main confirms it natively and names what goes. Allow rules,
 * allowances and the sandbox opt-out going is a tightening and is not listed.
 */
function protectionLosses({ denyRules = 0, patterns = [], askAllDefaults = 0, askAllMode = false }, t) {
  const lines = [];
  if (denyRules > 0) lines.push(t('permissionDialog.losses.blocks', { count: denyRules }));
  if (patterns.length > 0) lines.push(t('permissionDialog.losses.patterns', { patterns: patterns.join(', ') }));
  if (askAllDefaults > 0) {
    lines.push(t('permissionDialog.losses.askAllDefaults', { count: askAllDefaults, askAll: t('permissions.mode.askAll') }));
  }
  if (askAllMode) lines.push(t('permissionDialog.losses.askAllMode', { askAll: t('permissions.mode.askAll'), smart: t('permissions.mode.smart') }));
  return lines;
}

function resetDialog(kind, losses, t, root = '') {
  return {
    type: 'warning',
    title: t(`permissionDialog.${kind}.title`),
    message: t(`permissionDialog.${kind}.title`),
    detail: [
      t(`permissionDialog.${kind}.detail`, { root }),
      ...(losses.length > 0
        ? [t('permissionDialog.losses.intro'), losses.map((line) => `• ${line}`).join('\n')]
        : []),
    ].join('\n\n'),
    buttons: [t(`permissionDialog.${kind}.confirm`), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

function removePatternsDialog(patterns, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.removePatterns.title'),
    message: t('permissionDialog.removePatterns.title'),
    detail: t('permissionDialog.removePatterns.detail', { patterns: patterns.join(', '), smart: t('permissions.mode.smart') }),
    buttons: [t('permissionDialog.removePatterns.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * "Always allow this command" (#121). The dialog repeats exactly what is
 * remembered — command, folder, network — because that is the whole rule:
 * a different spelling of the command is a different command.
 */
function commandRuleDialog(rule, t) {
  const facts = [
    t('permissionDialog.commandRule.command', { command: rule.command }),
    t('permissionDialog.commandRule.cwd', { cwd: rule.cwd || t('permissionDialog.commandRule.cwd.root') }),
    rule.networkDomains.length > 0
      ? t('permissionDialog.commandRule.network', { domains: rule.networkDomains.join(', ') })
      : t('permissionDialog.commandRule.network.none'),
  ];
  return {
    type: 'warning',
    title: t('permissionDialog.commandRule.title'),
    message: t('permissionDialog.commandRule.title'),
    detail: t('permissionDialog.commandRule.detail', {
      facts: facts.join('\n'),
      root: rule.root,
      mode: t('permissions.mode.smart'),
      place: menuPath(t.locale, 'settings.security'),
    }),
    buttons: [t('permissionDialog.commandRule.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * "For this workspace" on a connection card (#946). The dialog repeats what
 * is kept — the hosts and the folder — because that is the whole grant.
 */
function workspaceHostsDialog(hosts, root, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.workspaceHosts.title'),
    message: t('permissionDialog.workspaceHosts.title'),
    detail: t('permissionDialog.workspaceHosts.detail', {
      hosts: hosts.join('\n'),
      root,
      place: menuPath(t.locale, SANDBOX_SETTING_PAGE),
    }),
    buttons: [t('permissionDialog.workspaceHosts.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * Where the sandbox switch, the program allowances and the hosts live,
 * quoted in their dialogs (#357) — Settings › Tools › Security since #1119.
 */
const SANDBOX_SETTING_PAGE = 'settings.sandbox';

/** Hosts open in every workspace (#1119): only from the settings, never from a card. */
function globalHostsDialog(hosts, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.globalHosts.title'),
    message: t('permissionDialog.globalHosts.title'),
    detail: t('permissionDialog.globalHosts.detail', {
      hosts: hosts.join('\n'),
      place: menuPath(t.locale, SANDBOX_SETTING_PAGE),
    }),
    buttons: [t('permissionDialog.globalHosts.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/** New workspaces without the sandbox (#1119). */
function newWorkspaceSandboxOffDialog(t) {
  return {
    type: 'warning',
    title: t('permissionDialog.newWorkspaceSandboxOff.title'),
    message: t('permissionDialog.newWorkspaceSandboxOff.title'),
    detail: t('permissionDialog.newWorkspaceSandboxOff.detail', {
      mode: t('permissions.mode.auto'),
      place: menuPath(t.locale, SANDBOX_SETTING_PAGE),
    }),
    buttons: [t('permissionDialog.newWorkspaceSandboxOff.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/** "Reset the sandbox everywhere" (#1119): only takes rights away, but all of them. */
function resetSandboxDialog(t) {
  return {
    type: 'warning',
    title: t('permissionDialog.resetSandbox.title'),
    message: t('permissionDialog.resetSandbox.title'),
    detail: t('permissionDialog.resetSandbox.detail'),
    buttons: [t('permissionDialog.resetSandbox.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

function sandboxOffDialog(root, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.sandboxOff.title'),
    message: t('permissionDialog.sandboxOff.title'),
    detail: t('permissionDialog.sandboxOff.detail', {
      root,
      mode: t('permissions.mode.auto'),
      place: menuPath(t.locale, SANDBOX_SETTING_PAGE),
    }),
    buttons: [t('permissionDialog.sandboxOff.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/** "Auto" for every new chat in one workspace (#413). */
function workspaceAutoDialog(root, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.workspaceAuto.title'),
    message: t('permissionDialog.workspaceAuto.title'),
    detail: t('permissionDialog.workspaceAuto.detail', {
      root,
      mode: t('permissions.mode.auto'),
      smart: t('permissions.mode.smart'),
      place: menuPath(t.locale, 'settings.security'),
    }),
    buttons: [t('permissionDialog.workspaceAuto.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/** `/Users/me/x` → `~/x`, so the dialog reads like the settings list. */
function tildePath(value, homeDir) {
  if (!homeDir || typeof value !== 'string') return value;
  if (value === homeDir) return '~';
  return value.startsWith(`${homeDir}/`) ? `~${value.slice(homeDir.length)}` : value;
}

function programAllowanceDialog(entry, t, homeDir = '', root = null) {
  const lines = [];
  if (entry.domains.length > 0) lines.push(t('permissionDialog.allowance.domains', { domains: entry.domains.join(', ') }));
  if (entry.writePaths.length > 0) {
    lines.push(t('permissionDialog.allowance.folders', {
      folders: entry.writePaths.map((folder) => tildePath(folder, homeDir)).join(', '),
    }));
  }
  if (entry.trustd) lines.push(t('permissionDialog.allowance.trustd'));
  const program = entry.path.split('/').pop();
  return {
    type: 'warning',
    title: t('permissionDialog.allowance.title', { program }),
    message: t('permissionDialog.allowance.title', { program }),
    detail: [
      root
        ? t('permissionDialog.allowance.intro.workspace', { path: tildePath(entry.path, homeDir), root: tildePath(root, homeDir) })
        : t('permissionDialog.allowance.intro', { path: tildePath(entry.path, homeDir) }),
      lines.map((line) => `• ${line}`).join('\n'),
      t('permissionDialog.allowance.footer', { place: menuPath(t.locale, SANDBOX_SETTING_PAGE) }),
    ].join('\n\n'),
    buttons: [t('permissionDialog.allowance.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

function registerToolPermissionHandlers({
  ipcMain,
  // Only the folder picker of program allowances (#408); confirmations go
  // through `confirmations`.
  dialog,
  // The user-confirmation port (#980). Without one nothing loosens.
  confirmations = createRefusingConfirmation(),
  getMainWindow = () => null,
  toolPolicyStore,
  approvals,
  sessionGrants,
  getActiveWorkspaceRoot = () => null,
  REQ,
  PUSH,
  // Der Modus gehoert zum Chat (Issue #211): Was hier gesetzt wird, merkt sich
  // der laufende Chat und bekommt es beim naechsten Oeffnen zurueck.
  chatSessionSettings = null,
  // Interface language for the native dialogs (#353), read afresh each time.
  getLocale = () => undefined,
  // Active execution tools and the sandbox state, for the mode pill (#357).
  describeExecutionTools = null,
  // Program allowances (#408): resolving programs and checking folders.
  programAllowances = null,
  // Titles of the chats that hold session approvals (#447): chatId → title.
  describeChats = async () => new Map(),
  // The Security page (#448): every tool with its classes and whether it is
  // offered, and the chats of a workspace with the mode each one runs on.
  describeTools = async () => [],
  describeWorkspaceChats = async () => [],
  // Every folder Snotra has worked in (#1119), for new workspaces without
  // the sandbox: those keep their setting.
  listKnownWorkspaces = async () => [],
  // Whether a folder is still there (#1119): a missing one is listed as such.
  folderExists = async () => true,
  platform = process.platform,
  // The platform capability register, resolved at start (#1149): whether
  // there is a sandbox at all is read from it, not from the platform's name.
  platformCapabilities = resolvePlatform({ platform }),
  homeDir = '',
}) {
  if (!toolPolicyStore || !approvals || !sessionGrants) {
    throw new Error('registerToolPermissionHandlers requires toolPolicyStore, approvals and sessionGrants.');
  }

  /** The receipt of a confirmed loosening (#980), or null when it was not confirmed. */
  async function confirmLoosening(action, subject, prompt) {
    const outcome = await confirmations.confirm({ action, subject, prompt });
    return outcome?.confirmed === true && outcome.receipt ? outcome.receipt : null;
  }

  /**
   * Whether a loosening ("Auto", the sandbox off) can be stored at all: it
   * needs the signature, and so `safeStorage`. Asked before the native
   * dialog, so that no confirmation leads nowhere (#419, CR-B14-09).
   */
  async function canStoreLoosening() {
    try {
      return (await toolPolicyStore.read()).encryptionAvailable === true;
    } catch {
      return false;
    }
  }

  /** Nach jeder Änderung: offene Karten verwerfen, Sitzungsfreigaben löschen, Renderer informieren. */
  function afterPolicyChange(sender) {
    approvals.invalidateAll(PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
    sessionGrants.clear();
    if (sender && typeof sender.send === 'function' && !sender.isDestroyed?.()) {
      sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    }
  }

  /**
   * A mode change belongs to the chat on screen (#211), so only its cards and
   * session approvals go (#320). A run in another chat keeps working under its
   * own mode and keeps what the user granted it. Without a known chat, the old,
   * wider reset applies.
   */
  function afterModeChange(sender) {
    const chatId = chatSessionSettings?.getCurrentChatId?.() ?? null;
    if (!chatId || typeof approvals.invalidateChat !== 'function' || typeof sessionGrants.clearChat !== 'function') {
      afterPolicyChange(sender);
      return;
    }
    approvals.invalidateChat(chatId, PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
    sessionGrants.clearChat(chatId);
    if (sender && typeof sender.send === 'function' && !sender.isDestroyed?.()) {
      sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    }
  }

  /**
   * Would shell_execute or run_python run without sandbox here (#357)?
   * True when one of them is offered and the sandbox is switched off for the
   * workspace or not available on this system. The mode pill warns in "Auto"
   * then, and the shield next to the folder name in any mode (#396, #398).
   * `pending`: the detection has not answered yet — isolated so far, but
   * not confirmed.
   */
  async function describeUnisolatedExecution(sandboxDisabled) {
    const none = { unisolated: false, tools: [], reason: '', pending: false };
    if (typeof describeExecutionTools !== 'function') return none;
    let described;
    try {
      described = await describeExecutionTools();
    } catch {
      return none;
    }
    const tools = Array.isArray(described?.active) ? described.active : [];
    if (tools.length === 0) return { ...none, tools };
    if (sandboxDisabled) return { unisolated: true, tools, reason: 'workspace', pending: false };
    const sandbox = described?.sandbox;
    if (sandbox?.status === 'unavailable') {
      return { unisolated: true, tools, reason: typeof sandbox.reason === 'string' ? sandbox.reason : '', pending: false };
    }
    const pending = sandbox?.status === 'unknown' || sandbox?.status === 'testing';
    return { unisolated: false, tools, reason: '', pending };
  }

  /**
   * The session approvals as the settings list them (#447): display data and
   * an opaque id, grouped by the renderer. Nothing that matches an approval —
   * scope key, file version, provider key — leaves main.
   */
  async function describeSessionGrants() {
    const grants = typeof sessionGrants.list === 'function' ? sessionGrants.list() : [];
    if (grants.length === 0) return [];
    const currentChatId = chatSessionSettings?.getCurrentChatId?.() ?? null;
    let titles = new Map();
    try {
      titles = (await describeChats([...new Set(grants.map((grant) => grant.chatId).filter(Boolean))])) || new Map();
    } catch {
      /* without titles the list still works */
    }
    return grants.map((grant) => ({
      id: grant.id,
      tool: grant.tool,
      classes: grant.classes,
      scope: grant.scope,
      // What a sandbox card opened (#792): a folder, a path or a host (#1119).
      ...(typeof grant.sandbox === 'string' && grant.sandbox ? { sandbox: grant.sandbox } : {}),
      grantedAt: grant.grantedAt,
      chatId: grant.chatId,
      chatTitle: (grant.chatId && titles.get(grant.chatId)) || '',
      current: !!grant.chatId && grant.chatId === currentChatId,
    }));
  }

  /** Every root the policy holds a sandbox setting or an allowance for (#1119). */
  function sandboxRootsOf(state) {
    return [...new Set([
      ...(Array.isArray(state.unsandboxedWorkspaces) ? state.unsandboxedWorkspaces : []),
      ...Object.keys(state.workspaceProgramAllowances || {}),
      ...Object.keys(state.workspaceHosts || {}),
    ])];
  }

  /**
   * The workspace a sandbox setting is changed for (#1119): the open one
   * when the renderer names none — or one the policy holds a sandbox
   * setting for already, so a workspace can be checked and cleaned up
   * without opening it. Never a path the renderer makes up: anything else is
   * null. Every loosening names the root in its system dialog.
   */
  async function sandboxRootFor(raw) {
    const active = getActiveWorkspaceRoot() || null;
    if (raw === undefined || raw === null || raw === '') return active;
    if (typeof raw !== 'string') return null;
    if (raw === active) return raw;
    try {
      return sandboxRootsOf(await toolPolicyStore.read()).includes(raw) ? raw : null;
    } catch {
      // Rules that cannot be read name no workspace: nothing is changed then.
      return null;
    }
  }

  /**
   * Settings › Tools › Security (#1119): every workspace that has a sandbox
   * setting or an allowance, and the open one; what applies in every
   * workspace; and the sandbox's session allowances of the open workspace's
   * chats. The open workspace comes first, the others by name.
   */
  async function buildSandboxOverview() {
    const state = await toolPolicyStore.read();
    const active = getActiveWorkspaceRoot() || null;
    const [described, grants, chats] = await Promise.all([
      typeof describeExecutionTools === 'function'
        ? Promise.resolve().then(describeExecutionTools)
          .catch(() => null /* without the sandbox's state the page still lists every workspace */)
        : null,
      describeSessionGrants(),
      active
        ? Promise.resolve().then(() => describeWorkspaceChats(active))
          .catch(() => [] /* without the chats no session allowance is listed; the rest stands */)
        : [],
    ]);
    const chatIds = new Set((Array.isArray(chats) ? chats : []).map((chat) => chat.id));
    const others = sandboxRootsOf(state).filter((root) => root !== active)
      .sort((a, b) => a.split(/[\\/]/).pop().localeCompare(b.split(/[\\/]/).pop()) || a.localeCompare(b));
    const roots = active ? [active, ...others] : others;
    const workspaces = await Promise.all(roots.map(async (root) => ({
      root,
      open: root === active,
      missing: root === active ? false : !(await Promise.resolve().then(() => folderExists(root))
        .catch(() => true /* a folder that cannot be checked is not called missing */)),
      sandboxOff: state.unsandboxedWorkspaces.includes(root),
      programs: state.workspaceProgramAllowances?.[root] || [],
      hosts: state.workspaceHosts?.[root] || [],
    })));
    const sandbox = platformCapabilities.executionSandbox === false
      ? { isolated: false, status: 'unavailable', reason: 'platform', platform }
      : described?.sandbox || null;
    return {
      integrity: state.integrity,
      platform,
      platformCapabilities,
      homeDir,
      sandbox,
      activeRoot: active,
      newWorkspaceSandbox: state.newWorkspaceSandboxOff !== true,
      global: {
        programs: Array.isArray(state.programAllowances) ? state.programAllowances : [],
        hosts: Array.isArray(state.globalHosts) ? state.globalHosts : [],
      },
      workspaces,
      sessionGrants: grants.filter((grant) => grant.sandbox && (grant.current || chatIds.has(grant.chatId))),
    };
  }

  async function buildState() {
    const state = await toolPolicyStore.read();
    const root = getActiveWorkspaceRoot();
    const workspaceSandboxDisabled = !!root && Array.isArray(state.unsandboxedWorkspaces)
      && state.unsandboxedWorkspaces.includes(root);
    return {
      mode: state.mode,
      integrity: state.integrity,
      // Whether "Auto" can be stored at all is the platform's (#1156); the
      // store still asks safeStorage itself before it signs anything.
      platformCapabilities,
      legacyWriteMigrated: state.legacyWriteMigrated === true,
      globalRules: state.globalRules,
      workspaceRules: root && state.workspaceRules[root] ? state.workspaceRules[root] : [],
      workspaceRoot: root,
      // Hosts connection cards kept open for this workspace (#946).
      workspaceHosts: root && Array.isArray(state.workspaceHosts?.[root]) ? state.workspaceHosts[root] : [],
      // Whether the execution tools run without sandbox in this workspace (#357).
      workspaceSandboxDisabled,
      // What new chats in this workspace start with (#413); null without one.
      workspaceMode: root
        ? (state.workspaceModes && state.workspaceModes[root]) || TOOL_PERMISSION_MODES.SMART
        : null,
      executionIsolation: await describeUnisolatedExecution(workspaceSandboxDisabled),
      sensitivePathPatterns: state.sensitivePathPatterns,
      // For every workspace (#408), and this workspace's own (#1119).
      programAllowances: Array.isArray(state.programAllowances) ? state.programAllowances : [],
      workspacePrograms: root && Array.isArray(state.workspaceProgramAllowances?.[root]) ? state.workspaceProgramAllowances[root] : [],
      // Hosts kept open in every workspace (#1119).
      globalHosts: Array.isArray(state.globalHosts) ? state.globalHosts : [],
      platform,
      homeDir,
      sessionGrantCount: sessionGrants.count(),
      sessionGrants: await describeSessionGrants(),
      policyVersion: state.policyVersion,
    };
  }

  ipcMain.handle(REQ.TOOL_PERMISSIONS_GET_STATE, async () => buildState());

  /**
   * Settings › Security (#448): what may run in the open workspace, per risk
   * class. Computed here from the same store read and the same matrix the
   * planner uses; the renderer only draws it. The page describes the folder,
   * so its mode is the folder's default — chats that differ are named.
   */
  async function buildSecurityOverview() {
    const state = await toolPolicyStore.read();
    const root = getActiveWorkspaceRoot();
    const workspaceSandboxDisabled = !!root && Array.isArray(state.unsandboxedWorkspaces)
      && state.unsandboxedWorkspaces.includes(root);
    const [tools, chats, isolation, grants, described] = await Promise.all([
      Promise.resolve().then(describeTools).catch(() => []),
      root ? Promise.resolve().then(() => describeWorkspaceChats(root)).catch(() => []) : [],
      describeUnisolatedExecution(workspaceSandboxDisabled),
      describeSessionGrants(),
      typeof describeExecutionTools === 'function'
        ? Promise.resolve().then(describeExecutionTools).catch(() => null)
        : null,
    ]);
    const chatIds = new Set((Array.isArray(chats) ? chats : []).map((chat) => chat.id));
    const currentChatId = chatSessionSettings?.getCurrentChatId?.() ?? null;
    const mode = root
      ? (state.workspaceModes && state.workspaceModes[root]) || TOOL_PERMISSION_MODES.SMART
      : TOOL_PERMISSION_MODES.SMART;
    return describeSecurityOverview({
      root,
      mode,
      globalRules: state.globalRules,
      workspaceRules: root && state.workspaceRules[root] ? state.workspaceRules[root] : [],
      tools,
      // Approvals of this folder's chats; one of another folder that is still
      // running in the background belongs to that folder's page.
      sessionGrants: grants.filter((grant) => grant.current || chatIds.has(grant.chatId)),
      chats: (Array.isArray(chats) ? chats : []).map((chat) =>
        // The chat on screen runs on the store's mode, which may not be saved
        // with the chat yet (chat-session-settings.js).
        // A chat without a mode of its own starts on the default.
        (chat.id === currentChatId ? { ...chat, mode: state.mode, current: true } : { ...chat, mode: chat.mode || mode })),
      execution: {
        sandbox: described?.sandbox || null,
        workspaceSandboxDisabled,
        unisolated: isolation.unisolated,
        pending: isolation.pending,
        programAllowances: Array.isArray(state.programAllowances) ? state.programAllowances : [],
        workspaceHosts: root && Array.isArray(state.workspaceHosts?.[root]) ? state.workspaceHosts[root] : [],
        // What the line leading to Tools › Security counts (#1119).
        workspacePrograms: root && Array.isArray(state.workspaceProgramAllowances?.[root]) ? state.workspaceProgramAllowances[root] : [],
        globalHosts: Array.isArray(state.globalHosts) ? state.globalHosts : [],
      },
      sensitivePathPatterns: state.sensitivePathPatterns,
      integrity: state.integrity,
    });
  }

  ipcMain.handle(REQ.TOOL_PERMISSIONS_GET_SECURITY_OVERVIEW, async () => buildSecurityOverview());

  ipcMain.handle(REQ.TOOL_PERMISSIONS_GET_SANDBOX_OVERVIEW, async () => buildSandboxOverview());

  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_MODE, async (event, rawMode) => {
    const mode = normalizeToolPermissionMode(rawMode);
    if (mode !== rawMode) return createSettingsError(createMessage('permissions.error.unknownMode'));
    // "Auto" is confirmed for the chat on screen, and remembered for it (#980).
    const chatId = chatSessionSettings?.getCurrentChatId?.() ?? null;
    let confirmation = null;
    if (mode === TOOL_PERMISSION_MODES.AUTO) {
      // Without safeStorage "Auto" cannot be stored (#419): say so instead of
      // asking for a confirmation that leads nowhere.
      if (!(await canStoreLoosening())) return createSettingsError(createMessage('permissions.error.autoNeedsEncryption'));
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.MODE_AUTO, chatId || '', autoModeDialog(createTranslator(getLocale())));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.autoNotEnabled'), 'cancelled');
    }
    const result = await toolPolicyStore.setMode(mode, { confirmation, chatId });
    if (!result.ok) return createSettingsError(result.error);
    await chatSessionSettings?.rememberMode(result.mode);
    afterModeChange(event.sender);
    return { ...createSettingsOk(), mode: result.mode };
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_ADD_RULE, async (event, rawRule) => {
    const candidate = rawRule && typeof rawRule === 'object' ? { ...rawRule } : null;
    if (!candidate) return createSettingsError(createMessage('permissions.error.invalidRule'));
    // Workspace-Regeln binden immer den aktiven Root aus dem Main, nie einen
    // vom Renderer gelieferten Pfad (Konzept §5/§7).
    if (candidate.scope === PERMISSION_RULE_SCOPES.WORKSPACE) {
      const root = getActiveWorkspaceRoot();
      if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
      candidate.root = root;
    } else {
      candidate.scope = PERMISSION_RULE_SCOPES.GLOBAL;
      delete candidate.root;
    }
    delete candidate.id;
    // A command is remembered from its card, with the dialog that repeats the
    // command line (#121); this channel's dialog never shows it (#517).
    if (candidate.command !== undefined && candidate.command !== null) {
      return createSettingsError(createMessage('permissions.error.commandRuleFromCard'));
    }
    const preview = normalizePermissionRule({ ...candidate, id: 'preview' });
    if (!preview) return createSettingsError(createMessage('permissions.error.invalidRule'));
    if (preview.effect === PERMISSION_RULE_EFFECTS.ALLOW && preview.tool) {
      // An allow rule for a tool that executes or reaches out would be
      // confirmed and listed, and then never apply (#517).
      const tools = await Promise.resolve().then(describeTools).catch(() => []);
      const known = (Array.isArray(tools) ? tools : []).find((tool) => tool && tool.name === preview.tool);
      const classes = Array.isArray(known?.riskClasses) ? known.riskClasses : [];
      if (classes.some((cls) => !PERSISTENT_ALLOW_CLASSES.includes(cls))) {
        return createSettingsError(createMessage('permissions.error.allowNotForTool', { tool: preview.tool }));
      }
    }
    let confirmation = null;
    if (preview.effect === PERMISSION_RULE_EFFECTS.ALLOW) {
      confirmation = await confirmLoosening(
        CONFIRMATION_ACTIONS.ALLOW_RULE,
        permissionRuleSubject(preview),
        allowRuleDialog(preview, createTranslator(getLocale())),
      );
      if (!confirmation) return createSettingsError(createMessage('permissions.error.ruleNotCreated'), 'cancelled');
    }
    const result = await toolPolicyStore.addRule(candidate, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_RULE, async (event, ruleId) => {
    const id = typeof ruleId === 'string' ? ruleId.trim() : '';
    if (!id) return createSettingsError(createMessage('permissions.error.ruleIdMissing'));
    const rule = await toolPolicyStore.findRule(id);
    if (!rule) return createSettingsError(createMessage('permissions.error.ruleNotFound'));
    let confirmation = null;
    if (rule.effect === PERMISSION_RULE_EFFECTS.DENY) {
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.REMOVE_BLOCK, id, removeDenyRuleDialog(rule, createTranslator(getLocale())));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.denyNotRemoved'), 'cancelled');
    }
    const result = await toolPolicyStore.removeRule(id, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, async (event, rawPatterns) => {
    if (!Array.isArray(rawPatterns)) return createSettingsError(createMessage('permissions.error.patternsExpected'));
    const next = normalizeSensitivePathPatterns(rawPatterns);
    // Dropping a pattern turns files that asked into ordinary reads (#514).
    const current = (await toolPolicyStore.read()).sensitivePathPatterns || [];
    const removed = current.filter((pattern) => !next.includes(pattern));
    let confirmation = null;
    if (removed.length > 0) {
      confirmation = await confirmLoosening(
        CONFIRMATION_ACTIONS.REMOVE_SENSITIVE_PATTERNS,
        removedPatternsSubject(removed),
        removePatternsDialog(removed, createTranslator(getLocale())),
      );
      if (!confirmation) return createSettingsError(createMessage('permissions.error.patternsNotRemoved'), 'cancelled');
    }
    const result = await toolPolicyStore.setSensitivePathPatterns(next, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return { ...createSettingsOk(), sensitivePathPatterns: result.sensitivePathPatterns };
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_CLEAR_SESSION_GRANTS, async (event) => {
    sessionGrants.clear();
    approvals.invalidateAll(PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
    if (!event.sender.isDestroyed?.()) event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    return createSettingsOk();
  });

  // One approval, by the id the list showed (#447). Revoking only tightens:
  // no dialog, no open card is voided, the next identical call asks again. An
  // id that is gone by now — the chat was left, a rule changed — is no error.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_REVOKE_SESSION_GRANT, async (event, grantId) => {
    const id = typeof grantId === 'string' ? grantId.trim() : '';
    if (!id || id.length > 200) return createSettingsError(createMessage('permissions.error.grantIdMissing'));
    const revoked = sessionGrants.revoke(id);
    if (!event.sender.isDestroyed?.()) event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    return { ...createSettingsOk(), revoked };
  });

  // A host kept open for a workspace (#946), by the name the page showed —
  // the open one, or one listed on Tools › Security (#1119). Closing one only
  // tightens: no dialog, no card or approval is voided.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_WORKSPACE_HOST, async (event, rawHost, rawRoot) => {
    const host = typeof rawHost === 'string' ? rawHost.trim() : '';
    if (!host || host.length > 300) return createSettingsError(createMessage('permissions.workspaceHosts.error.invalid'));
    const root = await sandboxRootFor(rawRoot);
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const result = await toolPolicyStore.removeWorkspaceHost(root, host);
    if (!result.ok) return createSettingsError(result.error);
    if (!event.sender.isDestroyed?.()) event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    return createSettingsOk();
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES, async (event) => {
    const root = getActiveWorkspaceRoot();
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const state = await toolPolicyStore.read();
    const t = createTranslator(getLocale());
    const losses = protectionLosses({
      denyRules: (state.workspaceRules?.[root] || []).filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY).length,
      askAllDefaults: state.workspaceModes?.[root] === TOOL_PERMISSION_MODES.ASK_ALL ? 1 : 0,
    }, t);
    let confirmation = null;
    if (losses.length > 0) {
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.RESET_WORKSPACE, root, resetDialog('resetWorkspace', losses, t, root));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.resetCancelled'), 'cancelled');
    }
    const result = await toolPolicyStore.resetWorkspaceRules(root, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  // The sandbox of the execution tools, per workspace (#357). Off is a
  // loosening and goes through the native dialog — unless it cannot be stored,
  // which is said before any dialog; on never asks. The root is the active
  // one, or one main already holds a sandbox setting for (#1119) — never a
  // new path the renderer names.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, async (event, enabled, rawRoot) => {
    if (typeof enabled !== 'boolean') return createSettingsError(createMessage('permissions.error.invalidSandboxSetting'));
    const root = await sandboxRootFor(rawRoot);
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    let confirmation = null;
    if (!enabled) {
      if (!(await canStoreLoosening())) return createSettingsError(createMessage('permissions.error.sandboxOffNeedsEncryption'));
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.SANDBOX_OFF, root, sandboxOffDialog(root, createTranslator(getLocale())));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.sandboxNotSwitchedOff'), 'cancelled');
    }
    const result = await toolPolicyStore.setWorkspaceSandbox(root, enabled, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return { ...createSettingsOk(), workspaceSandboxDisabled: !enabled };
  });

  // The mode new chats in the active workspace start with (#413). It changes
  // nothing for a chat that is open, so no card and no approval is voided.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, async (event, rawMode) => {
    const mode = normalizeToolPermissionMode(rawMode);
    if (mode !== rawMode) return createSettingsError(createMessage('permissions.error.unknownMode'));
    const root = getActiveWorkspaceRoot();
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const current = await toolPolicyStore.readWorkspaceMode(root);
    let confirmation = null;
    if (mode === TOOL_PERMISSION_MODES.AUTO && current !== TOOL_PERMISSION_MODES.AUTO) {
      if (!(await canStoreLoosening())) return createSettingsError(createMessage('permissions.error.autoNeedsEncryption'));
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.WORKSPACE_AUTO, root, workspaceAutoDialog(root, createTranslator(getLocale())));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.workspaceAutoNotSet'), 'cancelled');
    }
    const result = await toolPolicyStore.setWorkspaceMode(root, mode, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    if (!event.sender.isDestroyed?.()) event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    return { ...createSettingsOk(), workspaceMode: mode };
  });

  /**
   * The scope an allowance is stored in (#1119): `{ root: null }` for every
   * workspace, or the workspace it names — the open one, or one listed on
   * the page. Null when the renderer names a scope main does not know.
   */
  async function allowanceScopeFor(scope, rawRoot) {
    if (scope === 'global') return { root: null };
    if (scope !== 'workspace') return null;
    const root = await sandboxRootFor(rawRoot);
    return root ? { root } : null;
  }

  // Program allowances (#408), for one workspace or every workspace (#1119).
  // The renderer sends what the dialog holds; main resolves the program and
  // checks the folders on its own, and asks natively before anything widens
  // the sandbox — a move from one workspace to every workspace included.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, async (event, raw) => {
    if (!programAllowances) return createSettingsError(createMessage('permissions.allowance.error.unavailable'));
    const data = raw && typeof raw === 'object' ? raw : {};
    // Before #1119 every allowance was global; a caller that names no scope still means that.
    const target = await allowanceScopeFor(data.scope === undefined ? 'global' : data.scope, data.root);
    if (!target) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const prepared = await programAllowances.prepareEntry(data);
    if (!prepared.ok) return createSettingsError(prepared.error);
    const entry = prepared.entry;
    const replacePath = normalizeAllowancePath(data.previousPath);
    let replaceRoot = target.root;
    if (replacePath) {
      const from = await allowanceScopeFor(data.previousScope === undefined ? data.scope ?? 'global' : data.previousScope, data.previousRoot);
      if (!from) return createSettingsError(createMessage('permissions.error.noWorkspace'));
      replaceRoot = from.root;
    }
    const state = await toolPolicyStore.read();
    const listOf = (root) => (root
      ? state.workspaceProgramAllowances?.[root] || []
      : Array.isArray(state.programAllowances) ? state.programAllowances : []);
    let previous = replacePath ? listOf(replaceRoot).find((other) => other.path === replacePath) || null : null;
    let previousRoot = replaceRoot;
    if (!previous) {
      previous = listOf(target.root).find((other) => other.path === entry.path) || null;
      previousRoot = target.root;
    }
    const narrowing = !!previous && isNarrowing(previous, entry) && (previousRoot === target.root || previousRoot === null);
    let confirmation = null;
    if (!narrowing) {
      confirmation = await confirmLoosening(
        CONFIRMATION_ACTIONS.PROGRAM_ALLOWANCE,
        programAllowanceSubject(entry.path, target.root),
        programAllowanceDialog(entry, createTranslator(getLocale()), homeDir, target.root),
      );
      if (!confirmation) return createSettingsError(createMessage('permissions.allowance.error.notSaved'), 'cancelled');
    }
    const result = await toolPolicyStore.setProgramAllowance(entry, {
      root: target.root,
      replacePath,
      replaceRoot,
      confirmation,
    });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return { ...createSettingsOk(), entry, root: target.root };
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_PROGRAM_ALLOWANCE, async (event, rawPath, rawScope) => {
    const programPath = normalizeAllowancePath(rawPath);
    if (!programPath) return createSettingsError(createMessage('permissions.allowance.error.invalid'));
    const scope = rawScope && typeof rawScope === 'object' ? rawScope : {};
    const target = await allowanceScopeFor(scope.scope === undefined ? 'global' : scope.scope, scope.root);
    if (!target) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const result = await toolPolicyStore.removeProgramAllowance(programPath, { root: target.root });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  // Hosts kept open from the settings (#1119): for one workspace, confirmed
  // like "For this workspace" on a card, or for every workspace — which only
  // this page offers. What may be typed is what a card could have offered.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_ADD_HOSTS, async (event, raw) => {
    const data = raw && typeof raw === 'object' ? raw : {};
    const typed = Array.isArray(data.hosts) ? data.hosts.filter((host) => typeof host === 'string' && host.length <= 300) : [];
    const hosts = grantedHosts(typed);
    if (hosts.length === 0 || hosts.length !== typed.length) {
      return createSettingsError(createMessage('permissions.hosts.error.invalid'));
    }
    if (!(await canStoreLoosening())) return createSettingsError(createMessage('permissions.workspaceHosts.error.needsEncryption'));
    const t = createTranslator(getLocale());
    if (data.scope === 'global') {
      const confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.GLOBAL_HOSTS, globalHostsSubject(hosts), globalHostsDialog(hosts, t));
      if (!confirmation) return createSettingsError(createMessage('permissions.hosts.error.notAdded'), 'cancelled');
      const result = await toolPolicyStore.addGlobalHosts(hosts, { confirmation });
      if (!result.ok) return createSettingsError(result.error);
    } else {
      const root = await sandboxRootFor(data.root);
      if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
      const confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.WORKSPACE_HOSTS, root, workspaceHostsDialog(hosts, root, t));
      if (!confirmation) return createSettingsError(createMessage('permissions.hosts.error.notAdded'), 'cancelled');
      const result = await toolPolicyStore.addWorkspaceHosts(root, hosts, { confirmation });
      if (!result.ok) return createSettingsError(result.error);
    }
    if (!event.sender.isDestroyed?.()) event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    return { ...createSettingsOk(), hosts };
  });

  // A host open everywhere (#1119), closed again — a tightening, no dialog.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_GLOBAL_HOST, async (event, rawHost) => {
    const host = typeof rawHost === 'string' ? rawHost.trim() : '';
    if (!host || host.length > 300) return createSettingsError(createMessage('permissions.workspaceHosts.error.invalid'));
    const result = await toolPolicyStore.removeGlobalHost(host);
    if (!result.ok) return createSettingsError(result.error);
    if (!event.sender.isDestroyed?.()) event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    return createSettingsOk();
  });

  // "Sandbox on in new workspaces" (#1119). Off is a loosening and asks;
  // the folders Snotra knows by then keep their setting. On never asks.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_NEW_WORKSPACE_SANDBOX, async (event, enabled) => {
    if (typeof enabled !== 'boolean') return createSettingsError(createMessage('permissions.error.invalidSandboxSetting'));
    let confirmation = null;
    let knownRoots = [];
    if (!enabled) {
      if (!(await canStoreLoosening())) return createSettingsError(createMessage('permissions.error.sandboxOffNeedsEncryption'));
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.NEW_WORKSPACE_SANDBOX_OFF, '', newWorkspaceSandboxOffDialog(createTranslator(getLocale())));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.sandboxNotSwitchedOff'), 'cancelled');
      try {
        knownRoots = (await listKnownWorkspaces()) || [];
      } catch {
        // The folders the policy holds settings for and the open one still keep theirs.
        knownRoots = [];
      }
      const active = getActiveWorkspaceRoot();
      if (active) knownRoots = [...knownRoots, active];
    }
    const result = await toolPolicyStore.setNewWorkspaceSandbox(enabled, { confirmation, knownRoots });
    if (!result.ok) return createSettingsError(result.error);
    if (!event.sender.isDestroyed?.()) event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    return { ...createSettingsOk(), newWorkspaceSandbox: enabled };
  });

  // "Reset sandbox for this workspace" (#1119), and "Remove" for a folder
  // that is gone: only takes rights away, so no dialog.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_SANDBOX, async (event, rawRoot) => {
    const root = await sandboxRootFor(rawRoot);
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const result = await toolPolicyStore.resetWorkspaceSandbox(root);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  // "Reset the sandbox everywhere" (#1119): asked first, because it takes
  // every allowance away at once.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_SANDBOX_EVERYWHERE, async (event) => {
    const confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.RESET_SANDBOX, '', resetSandboxDialog(createTranslator(getLocale())));
    if (!confirmation) return createSettingsError(createMessage('permissions.error.resetCancelled'), 'cancelled');
    const result = await toolPolicyStore.resetSandboxEverywhere();
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  // What the dialog's program field means, as the user's shell would find it.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESOLVE_PROGRAM, async (_event, text) => {
    if (!programAllowances) return createSettingsError(createMessage('permissions.allowance.error.unavailable'));
    const resolved = await programAllowances.resolveProgram(typeof text === 'string' ? text : '');
    if (!resolved.ok) return createSettingsError(resolved.error);
    return { ...createSettingsOk(), path: resolved.path, name: resolved.name };
  });

  // A folder for the allowance, picked natively and checked at once.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_CHOOSE_ALLOWANCE_FOLDER, async () => {
    if (!programAllowances || !dialog || typeof dialog.showOpenDialog !== 'function') {
      return createSettingsError(createMessage('permissions.allowance.error.unavailable'));
    }
    const t = createTranslator(getLocale());
    const options = {
      title: t('permissionDialog.allowance.folderTitle'),
      message: t('permissionDialog.allowance.folderTitle'),
      buttonLabel: t('permissionDialog.allowance.folderButton'),
      // Tool caches live in hidden folders more often than not.
      properties: ['openDirectory', 'showHiddenFiles'],
      ...(homeDir ? { defaultPath: homeDir } : {}),
    };
    const win = getMainWindow();
    const result = win && !win.isDestroyed?.()
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result?.canceled || !Array.isArray(result?.filePaths) || result.filePaths.length === 0) {
      return createSettingsError(createMessage('permissions.allowance.error.noFolder'), 'cancelled');
    }
    const checked = await programAllowances.validateWritePath(result.filePaths[0]);
    if (!checked.ok) return createSettingsError(checked.error);
    return { ...createSettingsOk(), path: checked.path };
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_ALL, async (event) => {
    const state = await toolPolicyStore.read();
    const t = createTranslator(getLocale());
    const losses = protectionLosses({
      denyRules: (state.rules || []).filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY).length,
      patterns: state.sensitivePathPatterns || [],
      askAllDefaults: Object.values(state.workspaceModes || {}).filter((mode) => mode === TOOL_PERMISSION_MODES.ASK_ALL).length,
      askAllMode: state.mode === TOOL_PERMISSION_MODES.ASK_ALL,
    }, t);
    // The widest action asks every time — it is the only confirmation the
    // page has for it; what protection goes with it is listed (#514).
    const confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.RESET_ALL, '', resetDialog('resetAll', losses, t));
    if (!confirmation) return createSettingsError(createMessage('permissions.error.resetCancelled'), 'cancelled');
    const result = await toolPolicyStore.resetAll({ confirmation });
    if (!result.ok) return createSettingsError(result.error);
    // Back to `smart` means every chat, including those in the background.
    chatSessionSettings?.forgetBackgroundModes?.();
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  // Freigabe-Karten: Anmeldung, Antwort, offene Anfragen.
  ipcMain.handle(REQ.TOOL_APPROVAL_SUBSCRIBE, async (event) => {
    approvals.subscribe(event.sender.id, event.sender);
    return createSettingsOk();
  });

  /**
   * "Always allow" on a card (#121): confirm natively, store the command rule,
   * then answer the card with the rule's id. Cancelling the dialog leaves the
   * card open — the command has not run, and the user decides again.
   *
   * No other card and no session approval is dropped: a new allow rule for
   * one command can only turn a question into an allowance, and nothing
   * granted before becomes wrong by it.
   */
  async function rememberCommand(event, { requestId }) {
    const request = approvals.getPendingRequest?.(event.sender.id, requestId);
    if (!request) return { error: createMessage('approval.error.noPending') };
    if (request.alwaysAllowed !== true || !request.commandRule) return { ruleId: null };
    const rule = normalizePermissionRule({ ...request.commandRule, id: 'preview' });
    if (!rule) return { error: createMessage('permissions.error.invalidRule') };
    const confirmation = await confirmLoosening(
      CONFIRMATION_ACTIONS.ALLOW_RULE,
      permissionRuleSubject(rule),
      commandRuleDialog(rule, createTranslator(getLocale())),
    );
    if (!confirmation) return { error: createMessage('approval.error.alwaysNotConfirmed'), code: 'cancelled' };
    // The run may have ended while the dialog was open; then nothing is kept.
    if (!approvals.getPendingRequest?.(event.sender.id, requestId)) {
      return { error: createMessage('approval.error.noPending') };
    }
    const stored = await toolPolicyStore.addRule(request.commandRule, { confirmation });
    if (!stored.ok) return { error: stored.error };
    if (event.sender && typeof event.sender.send === 'function' && !event.sender.isDestroyed?.()) {
      event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    }
    return { ruleId: stored.ruleId };
  }

  /**
   * "For this workspace" on a connection card (#946): confirm natively, store
   * the hosts the card offered — the chosen ones, checked against the open
   * request — then answer the card. The workspace is the one the run asked
   * in, held by main; the renderer names only which offer it picked.
   * Cancelling the dialog leaves the card open, like "Always allow".
   */
  async function keepHostsForWorkspace(event, { requestId, sandboxPaths }) {
    const request = approvals.getPendingRequest?.(event.sender.id, requestId);
    if (!request) return { error: createMessage('approval.error.noPending') };
    const entries = request.sandbox?.entries;
    const root = typeof request.workspaceRoot === 'string' ? request.workspaceRoot : '';
    if (request.workspaceAllowed !== true || !root || !Array.isArray(entries) || entries.length === 0) {
      return { stored: false };
    }
    const hosts = [...new Set(entries.map((entry, i) => {
      const pick = Array.isArray(sandboxPaths) ? sandboxPaths[i] : undefined;
      return entry.allow.includes(pick) ? pick : entry.allow[0];
    }))];
    const confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.WORKSPACE_HOSTS, root, workspaceHostsDialog(hosts, root, createTranslator(getLocale())));
    if (!confirmation) return { error: createMessage('approval.error.workspaceNotConfirmed'), code: 'cancelled' };
    // The command may have given up while the dialog was open; then nothing is kept.
    if (!approvals.getPendingRequest?.(event.sender.id, requestId)) {
      return { error: createMessage('approval.error.noPending') };
    }
    const stored = await toolPolicyStore.addWorkspaceHosts(root, hosts, { confirmation });
    if (!stored.ok) return { error: stored.error };
    if (event.sender && typeof event.sender.send === 'function' && !event.sender.isDestroyed?.()) {
      event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    }
    return { stored: true };
  }

  ipcMain.handle(REQ.TOOL_APPROVAL_RESPOND, async (event, payload) => {
    const response = normalizeToolApprovalResponse(payload);
    if (!response) return createSettingsError(createMessage('approval.error.invalidResponse'));
    if (response.response === APPROVAL_RESPONSES.ALLOW_ALWAYS) {
      const remembered = await rememberCommand(event, response);
      if (remembered.error) return createSettingsError(remembered.error, remembered.code);
      response.ruleId = remembered.ruleId;
    }
    if (response.response === APPROVAL_RESPONSES.ALLOW_WORKSPACE) {
      const kept = await keepHostsForWorkspace(event, response);
      if (kept.error) return createSettingsError(kept.error, kept.code);
      response.workspaceStored = kept.stored === true;
    }
    const result = approvals.respond(event.sender.id, response);
    if (!result.ok) return createSettingsError(result.error);
    return { ...createSettingsOk(), response: result.response };
  });

  ipcMain.handle(REQ.TOOL_APPROVAL_LIST_PENDING, async (event) => ({
    requests: approvals.listPending(event.sender.id),
  }));
}

module.exports = {
  registerToolPermissionHandlers,
  autoModeDialog,
  allowRuleDialog,
  removeDenyRuleDialog,
  sandboxOffDialog,
  workspaceAutoDialog,
  commandRuleDialog,
  workspaceHostsDialog,
  globalHostsDialog,
  newWorkspaceSandboxOffDialog,
  resetSandboxDialog,
  programAllowanceDialog,
  resetDialog,
  removePatternsDialog,
  protectionLosses,
};
