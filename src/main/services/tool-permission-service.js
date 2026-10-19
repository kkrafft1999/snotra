'use strict';

/**
 * The tool permissions (#66, concept §5–§8): their state, the overviews the
 * Security pages read, every change, and the answers to approval cards. Until
 * #1006 all of it lived in `ipc/tool-permission-handlers.js`; the handlers now
 * parse and delegate.
 *
 * The renderer reads the state, asks for changes and answers approval cards.
 * It is no security boundary: the three actions that loosen the protection as
 * a whole — switching "Auto" on, storing a persistent allow rule, removing a
 * deny rule — main confirms before it carries them out. Every change of mode
 * or rules voids open requests and session approvals (concept §7).
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
  isCommandRule,
  normalizeToolPermissionMode,
  normalizePermissionRule,
  normalizeSensitivePathPatterns,
  normalizeToolApprovalResponse,
} = require('../../shared/contracts/tool-permissions');
const { createSettingsOk, createSettingsError } = require('../../shared/contracts/settings');
const { createMessage } = require('../../shared/contracts/message');
const { createTranslator } = require('../../shared/i18n');
const { isNarrowing, normalizeAllowancePath } = require('../../shared/contracts/program-allowances');
const { grantedHosts } = require('./sandbox-violations');
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

/**
 * @typedef {ReturnType<typeof createTranslator>} Translator
 * @typedef {import('../../application/ports/user-confirmation-port').ConfirmationPrompt} ConfirmationPrompt
 * @typedef {import('../../shared/contracts/tool-permissions').PermissionRule} PermissionRule
 * @typedef {import('../../shared/contracts/tool-permissions').CommandRule} CommandRule
 * @typedef {import('../../shared/contracts/program-allowances').ProgramAllowance} ProgramAllowance
 * @typedef {() => void} Notify  tells the window that asked to read the permission state again
 * @typedef {ReturnType<typeof import('./tool-policy-store').createToolPolicyStore>} ToolPolicyStore
 * @typedef {Awaited<ReturnType<ToolPolicyStore['read']>>} PolicyState
 * @typedef {ReturnType<typeof import('./security-page-data').createSecurityPageData>} SecurityPageData
 * @typedef {NonNullable<ReturnType<typeof normalizeToolApprovalResponse>> & { ruleId?: string|null, workspaceStored?: boolean }} ApprovalAnswer
 *   an answer of the renderer, with what main adds before it reaches the waiting call
 * @typedef {{ entries?: Array<{ allow: string[] }> }} SandboxCardView  what is read of a sandbox card's `sandbox`
 */
const {
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
} = require('./tool-permission-dialogs');

/**
 * @param {object} deps
 * @param {import('../../application/ports/user-confirmation-port').UserConfirmationPort} [deps.confirmations]
 * @param {ToolPolicyStore} deps.toolPolicyStore
 * @param {Pick<ReturnType<typeof import('../adapters/tool-approval-adapter').createToolApprovalAdapter>,
 *   'respond' | 'getPendingRequest' | 'listPending' | 'invalidateAll' | 'invalidateChat'>} deps.approvals
 * @param {Pick<ReturnType<typeof import('../../application/permissions/session-grants').createSessionGrants>,
 *   'list' | 'count' | 'clear' | 'clearChat' | 'revoke'>} deps.sessionGrants
 * @param {() => string|null} [deps.getActiveWorkspaceRoot]
 * @param {Pick<ReturnType<typeof import('../../application/chat/chat-session-settings').createChatSessionSettings>,
 *   'getCurrentChatId' | 'rememberMode' | 'forgetBackgroundModes'>|null} [deps.chatSessionSettings]
 * @param {() => unknown} [deps.getLocale]
 * @param {SecurityPageData['describeExecutionTools']|null} [deps.describeExecutionTools]
 * @param {Pick<ReturnType<typeof import('./program-allowances-service').createProgramAllowances>,
 *   'prepareEntry' | 'resolveProgram' | 'validateWritePath'>|null} [deps.programAllowances]
 * @param {SecurityPageData['describeChats']} [deps.describeChats]
 * @param {SecurityPageData['describeTools']} [deps.describeTools]
 * @param {SecurityPageData['describeWorkspaceChats']} [deps.describeWorkspaceChats]
 * @param {SecurityPageData['listKnownWorkspaces']} [deps.listKnownWorkspaces]
 * @param {SecurityPageData['folderExists']} [deps.folderExists]
 * @param {string} [deps.platform]
 * @param {import('../../shared/contracts/platform-capabilities').PlatformCapabilities} [deps.platformCapabilities]
 * @param {string} [deps.homeDir]
 */
function createToolPermissionService({
  // The user-confirmation port (#980). Without one nothing loosens.
  confirmations = createRefusingConfirmation(),
  toolPolicyStore,
  approvals,
  sessionGrants,
  getActiveWorkspaceRoot = () => null,
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
    throw new Error('createToolPermissionService requires toolPolicyStore, approvals and sessionGrants.');
  }

  /**
   * The receipt of a confirmed loosening (#980), or null when it was not confirmed.
   *
   * @param {string} action
   * @param {string} subject
   * @param {ConfirmationPrompt} prompt
   * @returns {Promise<object|null>}
   */
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
      // Rules that cannot be read cannot store a loosening either.
      return false;
    }
  }

  /**
   * After every change: open cards are voided, session approvals cleared,
   * the renderer told.
   *
   * @param {Notify} notify
   */
  function afterPolicyChange(notify) {
    approvals.invalidateAll(PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
    sessionGrants.clear();
    notify();
  }

  /**
   * A mode change belongs to the chat on screen (#211), so only its cards and
   * session approvals go (#320). A run in another chat keeps working under its
   * own mode and keeps what the user granted it. Without a known chat, the old,
   * wider reset applies.
   *
   * @param {Notify} notify
   */
  function afterModeChange(notify) {
    const chatId = chatSessionSettings?.getCurrentChatId?.() ?? null;
    if (!chatId || typeof approvals.invalidateChat !== 'function' || typeof sessionGrants.clearChat !== 'function') {
      afterPolicyChange(notify);
      return;
    }
    approvals.invalidateChat(chatId, PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
    sessionGrants.clearChat(chatId);
    notify();
  }

  /**
   * Would shell_execute or run_python run without sandbox here (#357)?
   * True when one of them is offered and the sandbox is switched off for the
   * workspace or not available on this system. The mode pill warns in "Auto"
   * then, and the shield next to the folder name in any mode (#396, #398).
   * `pending`: the detection has not answered yet — isolated so far, but
   * not confirmed.
   *
   * @param {boolean} sandboxDisabled
   */
  async function describeUnisolatedExecution(sandboxDisabled) {
    const none = { unisolated: false, tools: [], reason: '', pending: false };
    if (typeof describeExecutionTools !== 'function') return none;
    let described;
    try {
      described = await describeExecutionTools();
    } catch {
      // Without the tools' state the pill shows no warning rather than a wrong one.
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
      titles = (await describeChats([...new Set(grants.flatMap((grant) => (grant.chatId ? [grant.chatId] : [])))])) || new Map();
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

  /**
   * Every root the policy holds a sandbox setting or an allowance for (#1119).
   *
   * @param {PolicyState} state
   */
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
   *
   * @param {any} raw  straight from the renderer
   * @returns {Promise<string|null>}
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
    /** @type {Set<string|null>} */
    const chatIds = new Set((Array.isArray(chats) ? chats : []).map((chat) => chat.id));
    const others = sandboxRootsOf(state).filter((root) => root !== active)
      .sort((a, b) => (a.split(/[\\/]/).pop() ?? '').localeCompare(b.split(/[\\/]/).pop() ?? '') || a.localeCompare(b));
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
      Promise.resolve().then(describeTools).catch(() => [] /* without the tools the page shows the rules alone */),
      root ? Promise.resolve().then(() => describeWorkspaceChats(root)).catch(() => [] /* no chats named, the rest stands */) : [],
      describeUnisolatedExecution(workspaceSandboxDisabled),
      describeSessionGrants(),
      typeof describeExecutionTools === 'function'
        ? Promise.resolve().then(describeExecutionTools).catch(() => null /* the sandbox line stays unknown */)
        : null,
    ]);
    /** @type {Set<string|null>} */
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



  /**
   * @param {Notify} notify
   * @param {unknown} rawMode
   */
  async function setMode(notify, rawMode) {
    const mode = normalizeToolPermissionMode(rawMode);
    if (mode !== rawMode) return createSettingsError(createMessage('permissions.error.unknownMode'));
    // "Auto" is confirmed for the chat on screen, and remembered for it (#980).
    const chatId = chatSessionSettings?.getCurrentChatId?.() ?? null;
    /** @type {object|null} */
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
    afterModeChange(notify);
    return { ...createSettingsOk(), mode: result.mode };
  }

  /**
   * @param {Notify} notify
   * @param {any} rawRule  straight from the renderer
   */
  async function addRule(notify, rawRule) {
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
      const tools = await Promise.resolve().then(describeTools).catch(() => [] /* without the catalogue the rule is confirmed but not checked against its tool */);
      const known = (Array.isArray(tools) ? tools : []).find((tool) => tool && tool.name === preview.tool);
      const classes = Array.isArray(known?.riskClasses) ? known.riskClasses : [];
      if (classes.some((cls) => !PERSISTENT_ALLOW_CLASSES.includes(cls))) {
        return createSettingsError(createMessage('permissions.error.allowNotForTool', { tool: preview.tool }));
      }
    }
    /** @type {object|null} */
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
    afterPolicyChange(notify);
    return createSettingsOk();
  }

  /**
   * @param {Notify} notify
   * @param {unknown} ruleId
   */
  async function removeRule(notify, ruleId) {
    const id = typeof ruleId === 'string' ? ruleId.trim() : '';
    if (!id) return createSettingsError(createMessage('permissions.error.ruleIdMissing'));
    const rule = await toolPolicyStore.findRule(id);
    if (!rule) return createSettingsError(createMessage('permissions.error.ruleNotFound'));
    /** @type {object|null} */
    let confirmation = null;
    if (rule.effect === PERMISSION_RULE_EFFECTS.DENY) {
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.REMOVE_BLOCK, id, removeDenyRuleDialog(rule, createTranslator(getLocale())));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.denyNotRemoved'), 'cancelled');
    }
    const result = await toolPolicyStore.removeRule(id, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(notify);
    return createSettingsOk();
  }

  /**
   * @param {Notify} notify
   * @param {unknown} rawPatterns
   */
  async function setSensitivePaths(notify, rawPatterns) {
    if (!Array.isArray(rawPatterns)) return createSettingsError(createMessage('permissions.error.patternsExpected'));
    const next = normalizeSensitivePathPatterns(rawPatterns);
    // Dropping a pattern turns files that asked into ordinary reads (#514).
    const current = (await toolPolicyStore.read()).sensitivePathPatterns || [];
    const removed = current.filter((pattern) => !next.includes(pattern));
    /** @type {object|null} */
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
    afterPolicyChange(notify);
    return { ...createSettingsOk(), sensitivePathPatterns: result.sensitivePathPatterns };
  }

  /**
   * @param {Notify} notify
   */
  async function clearSessionGrants(notify) {
    sessionGrants.clear();
    approvals.invalidateAll(PERMISSION_DENIAL_REASONS.REQUEST_INVALIDATED);
    notify();
    return createSettingsOk();
  }

  // One approval, by the id the list showed (#447). Revoking only tightens:
  // no dialog, no open card is voided, the next identical call asks again. An
  // id that is gone by now — the chat was left, a rule changed — is no error.
  /**
   * @param {Notify} notify
   * @param {unknown} grantId
   */
  async function revokeSessionGrant(notify, grantId) {
    const id = typeof grantId === 'string' ? grantId.trim() : '';
    if (!id || id.length > 200) return createSettingsError(createMessage('permissions.error.grantIdMissing'));
    const revoked = sessionGrants.revoke(id);
    notify();
    return { ...createSettingsOk(), revoked };
  }

  // A host kept open for a workspace (#946), by the name the page showed —
  // the open one, or one listed on Tools › Security (#1119). Closing one only
  // tightens: no dialog, no card or approval is voided.
  /**
   * @param {Notify} notify
   * @param {unknown} rawHost
   * @param {unknown} rawRoot
   */
  async function removeWorkspaceHost(notify, rawHost, rawRoot) {
    const host = typeof rawHost === 'string' ? rawHost.trim() : '';
    if (!host || host.length > 300) return createSettingsError(createMessage('permissions.workspaceHosts.error.invalid'));
    const root = await sandboxRootFor(rawRoot);
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const result = await toolPolicyStore.removeWorkspaceHost(root, host);
    if (!result.ok) return createSettingsError(result.error);
    notify();
    return createSettingsOk();
  }

  /**
   * @param {Notify} notify
   */
  async function resetWorkspaceRules(notify) {
    const root = getActiveWorkspaceRoot();
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const state = await toolPolicyStore.read();
    const t = createTranslator(getLocale());
    const losses = protectionLosses({
      denyRules: (state.workspaceRules?.[root] || []).filter((rule) => rule.effect === PERMISSION_RULE_EFFECTS.DENY).length,
      askAllDefaults: state.workspaceModes?.[root] === TOOL_PERMISSION_MODES.ASK_ALL ? 1 : 0,
    }, t);
    /** @type {object|null} */
    let confirmation = null;
    if (losses.length > 0) {
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.RESET_WORKSPACE, root, resetDialog('resetWorkspace', losses, t, root));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.resetCancelled'), 'cancelled');
    }
    const result = await toolPolicyStore.resetWorkspaceRules(root, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(notify);
    return createSettingsOk();
  }

  // The sandbox of the execution tools, per workspace (#357). Off is a
  // loosening and goes through the native dialog — unless it cannot be stored,
  // which is said before any dialog; on never asks. The root is the active
  // one, or one main already holds a sandbox setting for (#1119) — never a
  // new path the renderer names.
  /**
   * @param {Notify} notify
   * @param {unknown} enabled
   * @param {unknown} rawRoot
   */
  async function setWorkspaceSandbox(notify, enabled, rawRoot) {
    if (typeof enabled !== 'boolean') return createSettingsError(createMessage('permissions.error.invalidSandboxSetting'));
    const root = await sandboxRootFor(rawRoot);
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    /** @type {object|null} */
    let confirmation = null;
    if (!enabled) {
      if (!(await canStoreLoosening())) return createSettingsError(createMessage('permissions.error.sandboxOffNeedsEncryption'));
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.SANDBOX_OFF, root, sandboxOffDialog(root, createTranslator(getLocale())));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.sandboxNotSwitchedOff'), 'cancelled');
    }
    const result = await toolPolicyStore.setWorkspaceSandbox(root, enabled, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(notify);
    return { ...createSettingsOk(), workspaceSandboxDisabled: !enabled };
  }

  // The mode new chats in the active workspace start with (#413). It changes
  // nothing for a chat that is open, so no card and no approval is voided.
  /**
   * @param {Notify} notify
   * @param {unknown} rawMode
   */
  async function setWorkspaceMode(notify, rawMode) {
    const mode = normalizeToolPermissionMode(rawMode);
    if (mode !== rawMode) return createSettingsError(createMessage('permissions.error.unknownMode'));
    const root = getActiveWorkspaceRoot();
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const current = await toolPolicyStore.readWorkspaceMode(root);
    /** @type {object|null} */
    let confirmation = null;
    if (mode === TOOL_PERMISSION_MODES.AUTO && current !== TOOL_PERMISSION_MODES.AUTO) {
      if (!(await canStoreLoosening())) return createSettingsError(createMessage('permissions.error.autoNeedsEncryption'));
      confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.WORKSPACE_AUTO, root, workspaceAutoDialog(root, createTranslator(getLocale())));
      if (!confirmation) return createSettingsError(createMessage('permissions.error.workspaceAutoNotSet'), 'cancelled');
    }
    const result = await toolPolicyStore.setWorkspaceMode(root, mode, { confirmation });
    if (!result.ok) return createSettingsError(result.error);
    notify();
    return { ...createSettingsOk(), workspaceMode: mode };
  }

  /**
   * The scope an allowance is stored in (#1119): `{ root: null }` for every
   * workspace, or the workspace it names — the open one, or one listed on
   * the page. Null when the renderer names a scope main does not know.
   *
   * @param {unknown} scope
   * @param {unknown} rawRoot
   * @returns {Promise<{ root: string|null }|null>}
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
  /**
   * @param {Notify} notify
   * @param {any} raw  straight from the renderer
   */
  async function setProgramAllowance(notify, raw) {
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
    const listOf = (/** @type {string|null} */ root) => (root
      ? state.workspaceProgramAllowances?.[root] || []
      : Array.isArray(state.programAllowances) ? state.programAllowances : []);
    let previous = replacePath ? listOf(replaceRoot).find((other) => other.path === replacePath) || null : null;
    let previousRoot = replaceRoot;
    if (!previous) {
      previous = listOf(target.root).find((other) => other.path === entry.path) || null;
      previousRoot = target.root;
    }
    const narrowing = !!previous && isNarrowing(previous, entry) && (previousRoot === target.root || previousRoot === null);
    /** @type {object|null} */
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
    afterPolicyChange(notify);
    return { ...createSettingsOk(), entry, root: target.root };
  }

  /**
   * @param {Notify} notify
   * @param {unknown} rawPath
   * @param {any} rawScope  straight from the renderer
   */
  async function removeProgramAllowance(notify, rawPath, rawScope) {
    const programPath = normalizeAllowancePath(rawPath);
    if (!programPath) return createSettingsError(createMessage('permissions.allowance.error.invalid'));
    const scope = rawScope && typeof rawScope === 'object' ? rawScope : {};
    const target = await allowanceScopeFor(scope.scope === undefined ? 'global' : scope.scope, scope.root);
    if (!target) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const result = await toolPolicyStore.removeProgramAllowance(programPath, { root: target.root });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(notify);
    return createSettingsOk();
  }

  // Hosts kept open from the settings (#1119): for one workspace, confirmed
  // like "For this workspace" on a card, or for every workspace — which only
  // this page offers. What may be typed is what a card could have offered.
  /**
   * @param {Notify} notify
   * @param {any} raw  straight from the renderer
   */
  async function addHosts(notify, raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const typed = Array.isArray(data.hosts) ? data.hosts.filter((/** @type {unknown} */ host) => typeof host === 'string' && host.length <= 300) : [];
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
    notify();
    return { ...createSettingsOk(), hosts };
  }

  // A host open everywhere (#1119), closed again — a tightening, no dialog.
  /**
   * @param {Notify} notify
   * @param {unknown} rawHost
   */
  async function removeGlobalHost(notify, rawHost) {
    const host = typeof rawHost === 'string' ? rawHost.trim() : '';
    if (!host || host.length > 300) return createSettingsError(createMessage('permissions.workspaceHosts.error.invalid'));
    const result = await toolPolicyStore.removeGlobalHost(host);
    if (!result.ok) return createSettingsError(result.error);
    notify();
    return createSettingsOk();
  }

  // "Sandbox on in new workspaces" (#1119). Off is a loosening and asks;
  // the folders Snotra knows by then keep their setting. On never asks.
  /**
   * @param {Notify} notify
   * @param {unknown} enabled
   */
  async function setNewWorkspaceSandbox(notify, enabled) {
    if (typeof enabled !== 'boolean') return createSettingsError(createMessage('permissions.error.invalidSandboxSetting'));
    /** @type {object|null} */
    let confirmation = null;
    /** @type {string[]} */
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
    notify();
    return { ...createSettingsOk(), newWorkspaceSandbox: enabled };
  }

  // "Reset sandbox for this workspace" (#1119), and "Remove" for a folder
  // that is gone: only takes rights away, so no dialog.
  /**
   * @param {Notify} notify
   * @param {unknown} rawRoot
   */
  async function resetWorkspaceSandbox(notify, rawRoot) {
    const root = await sandboxRootFor(rawRoot);
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const result = await toolPolicyStore.resetWorkspaceSandbox(root);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(notify);
    return createSettingsOk();
  }

  // "Reset the sandbox everywhere" (#1119): asked first, because it takes
  // every allowance away at once.
  /**
   * @param {Notify} notify
   */
  async function resetSandboxEverywhere(notify) {
    const confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.RESET_SANDBOX, '', resetSandboxDialog(createTranslator(getLocale())));
    if (!confirmation) return createSettingsError(createMessage('permissions.error.resetCancelled'), 'cancelled');
    const result = await toolPolicyStore.resetSandboxEverywhere();
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(notify);
    return createSettingsOk();
  }

  // What the dialog's program field means, as the user's shell would find it.
  /**
   * @param {unknown} text
   */
  async function resolveProgram(text) {
    if (!programAllowances) return createSettingsError(createMessage('permissions.allowance.error.unavailable'));
    const resolved = await programAllowances.resolveProgram(typeof text === 'string' ? text : '');
    if (!resolved.ok) return createSettingsError(resolved.error);
    return { ...createSettingsOk(), path: resolved.path, name: resolved.name };
  }

  // A folder for the allowance, picked natively and checked at once.

  /**
   * @param {Notify} notify
   */
  async function resetAll(notify) {
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
    afterPolicyChange(notify);
    return createSettingsOk();
  }

  // Freigabe-Karten: Anmeldung, Antwort, offene Anfragen.

  /**
   * "Always allow" on a card (#121): confirm natively, store the command rule,
   * then answer the card with the rule's id. Cancelling the dialog leaves the
   * card open — the command has not run, and the user decides again.
   *
   * No other card and no session approval is dropped: a new allow rule for
   * one command can only turn a question into an allowance, and nothing
   * granted before becomes wrong by it.
   *
   * @param {number} sessionId  the window's id
   * @param {Notify} notify
   * @param {{ requestId: string }} response
   */
  async function rememberCommand(sessionId, notify, { requestId }) {
    const request = approvals.getPendingRequest?.(sessionId, requestId);
    if (!request) return { error: createMessage('approval.error.noPending') };
    if (request.alwaysAllowed !== true || !request.commandRule) return { ruleId: null };
    const rule = normalizePermissionRule({ ...request.commandRule, id: 'preview' });
    if (!rule || !isCommandRule(rule)) return { error: createMessage('permissions.error.invalidRule') };
    const confirmation = await confirmLoosening(
      CONFIRMATION_ACTIONS.ALLOW_RULE,
      permissionRuleSubject(rule),
      commandRuleDialog(rule, createTranslator(getLocale())),
    );
    if (!confirmation) return { error: createMessage('approval.error.alwaysNotConfirmed'), code: 'cancelled' };
    // The run may have ended while the dialog was open; then nothing is kept.
    if (!approvals.getPendingRequest?.(sessionId, requestId)) {
      return { error: createMessage('approval.error.noPending') };
    }
    const stored = await toolPolicyStore.addRule(request.commandRule, { confirmation });
    if (!stored.ok) return { error: stored.error };
    notify();
    return { ruleId: stored.ruleId };
  }

  /**
   * "For this workspace" on a connection card (#946): confirm natively, store
   * the hosts the card offered — the chosen ones, checked against the open
   * request — then answer the card. The workspace is the one the run asked
   * in, held by main; the renderer names only which offer it picked.
   * Cancelling the dialog leaves the card open, like "Always allow".
   *
   * @param {number} sessionId  the window's id
   * @param {Notify} notify
   * @param {{ requestId: string, sandboxPaths?: string[] }} response
   */
  async function keepHostsForWorkspace(sessionId, notify, { requestId, sandboxPaths }) {
    const request = approvals.getPendingRequest?.(sessionId, requestId);
    if (!request) return { error: createMessage('approval.error.noPending') };
    /** @type {SandboxCardView|undefined} */
    const sandbox = request.sandbox;
    const entries = sandbox?.entries;
    const root = typeof request.workspaceRoot === 'string' ? request.workspaceRoot : '';
    if (request.workspaceAllowed !== true || !root || !Array.isArray(entries) || entries.length === 0) {
      return { stored: false };
    }
    const hosts = [...new Set(entries.map((entry, i) => {
      const pick = Array.isArray(sandboxPaths) ? sandboxPaths[i] : undefined;
      return pick !== undefined && entry.allow.includes(pick) ? pick : entry.allow[0];
    }))];
    const confirmation = await confirmLoosening(CONFIRMATION_ACTIONS.WORKSPACE_HOSTS, root, workspaceHostsDialog(hosts, root, createTranslator(getLocale())));
    if (!confirmation) return { error: createMessage('approval.error.workspaceNotConfirmed'), code: 'cancelled' };
    // The command may have given up while the dialog was open; then nothing is kept.
    if (!approvals.getPendingRequest?.(sessionId, requestId)) {
      return { error: createMessage('approval.error.noPending') };
    }
    const stored = await toolPolicyStore.addWorkspaceHosts(root, hosts, { confirmation });
    if (!stored.ok) return { error: stored.error };
    notify();
    return { stored: true };
  }

  /**
   * @param {number} sessionId  the window's id
   * @param {Notify} notify
   * @param {any} payload  straight from the renderer
   */
  async function respondToApproval(sessionId, notify, payload) {
    /** @type {ApprovalAnswer|null} */
    const response = normalizeToolApprovalResponse(payload);
    if (!response) return createSettingsError(createMessage('approval.error.invalidResponse'));
    if (response.response === APPROVAL_RESPONSES.ALLOW_ALWAYS) {
      const remembered = await rememberCommand(sessionId, notify, response);
      if (remembered.error) return createSettingsError(remembered.error, remembered.code);
      response.ruleId = remembered.ruleId;
    }
    if (response.response === APPROVAL_RESPONSES.ALLOW_WORKSPACE) {
      const kept = await keepHostsForWorkspace(sessionId, notify, response);
      if (kept.error) return createSettingsError(kept.error, kept.code);
      response.workspaceStored = kept.stored === true;
    }
    const result = approvals.respond(sessionId, response);
    if (!result.ok) return createSettingsError(result.error);
    return { ...createSettingsOk(), response: result.response };
  }

  /**
   * @param {number} sessionId  the window's id
   */
  function listPendingApprovals(sessionId) {
    return { requests: approvals.listPending(sessionId) };
  }

  /**
   * A folder picked for an allowance, checked at once (#408).
   *
   * @param {string} folderPath
   */
  async function checkAllowanceFolder(folderPath) {
    if (!programAllowances) return createSettingsError(createMessage('permissions.allowance.error.unavailable'));
    const checked = await programAllowances.validateWritePath(folderPath);
    if (!checked.ok) return createSettingsError(checked.error);
    return { ...createSettingsOk(), path: checked.path };
  }

  return {
    buildState,
    buildSecurityOverview,
    buildSandboxOverview,
    setMode,
    addRule,
    removeRule,
    setSensitivePaths,
    clearSessionGrants,
    revokeSessionGrant,
    removeWorkspaceHost,
    resetWorkspaceRules,
    setWorkspaceSandbox,
    setWorkspaceMode,
    setProgramAllowance,
    removeProgramAllowance,
    addHosts,
    removeGlobalHost,
    setNewWorkspaceSandbox,
    resetWorkspaceSandbox,
    resetSandboxEverywhere,
    resolveProgram,
    checkAllowanceFolder,
    canCheckAllowanceFolders: () => !!programAllowances,
    resetAll,
    respondToApproval,
    listPendingApprovals,
  };
}

module.exports = { createToolPermissionService };
