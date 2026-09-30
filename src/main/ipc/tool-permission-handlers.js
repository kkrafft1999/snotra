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
 */

const {
  TOOL_PERMISSION_MODES,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  PERMISSION_DENIAL_REASONS,
  APPROVAL_RESPONSES,
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
const { describeSecurityOverview } = require('../../application/permissions/security-overview');

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

/** Where the sandbox switch lives, quoted in its dialog (#357). */
const SANDBOX_SETTING_PAGE = 'settings.security';

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

function programAllowanceDialog(entry, t, homeDir = '') {
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
      t('permissionDialog.allowance.intro', { path: tildePath(entry.path, homeDir) }),
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
  dialog,
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
  platform = process.platform,
  homeDir = '',
}) {
  if (!toolPolicyStore || !approvals || !sessionGrants) {
    throw new Error('registerToolPermissionHandlers requires toolPolicyStore, approvals and sessionGrants.');
  }

  async function confirmNatively(options) {
    if (!dialog || typeof dialog.showMessageBox !== 'function') return false;
    const win = getMainWindow();
    const result = win && !win.isDestroyed?.()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return result?.response === 0;
  }

  async function canStoreAuto() {
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
      grantedAt: grant.grantedAt,
      chatId: grant.chatId,
      chatTitle: (grant.chatId && titles.get(grant.chatId)) || '',
      current: !!grant.chatId && grant.chatId === currentChatId,
    }));
  }

  async function buildState() {
    const state = await toolPolicyStore.read();
    const root = getActiveWorkspaceRoot();
    const workspaceSandboxDisabled = !!root && Array.isArray(state.unsandboxedWorkspaces)
      && state.unsandboxedWorkspaces.includes(root);
    return {
      mode: state.mode,
      integrity: state.integrity,
      encryptionAvailable: state.encryptionAvailable,
      legacyWriteMigrated: state.legacyWriteMigrated === true,
      globalRules: state.globalRules,
      workspaceRules: root && state.workspaceRules[root] ? state.workspaceRules[root] : [],
      workspaceRoot: root,
      // Whether the execution tools run without sandbox in this workspace (#357).
      workspaceSandboxDisabled,
      // What new chats in this workspace start with (#413); null without one.
      workspaceMode: root
        ? (state.workspaceModes && state.workspaceModes[root]) || TOOL_PERMISSION_MODES.SMART
        : null,
      executionIsolation: await describeUnisolatedExecution(workspaceSandboxDisabled),
      sensitivePathPatterns: state.sensitivePathPatterns,
      // Global, like the rules for all workspaces (#408).
      programAllowances: Array.isArray(state.programAllowances) ? state.programAllowances : [],
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
      },
      sensitivePathPatterns: state.sensitivePathPatterns,
      integrity: state.integrity,
      encryptionAvailable: state.encryptionAvailable,
    });
  }

  ipcMain.handle(REQ.TOOL_PERMISSIONS_GET_SECURITY_OVERVIEW, async () => buildSecurityOverview());

  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_MODE, async (event, rawMode) => {
    const mode = normalizeToolPermissionMode(rawMode);
    if (mode !== rawMode) return createSettingsError(createMessage('permissions.error.unknownMode'));
    if (mode === TOOL_PERMISSION_MODES.AUTO) {
      // Without safeStorage "Auto" cannot be stored (#419): say so instead of
      // asking for a confirmation that leads nowhere.
      if (!(await canStoreAuto())) return createSettingsError(createMessage('permissions.error.autoNeedsEncryption'));
      const confirmed = await confirmNatively(autoModeDialog(createTranslator(getLocale())));
      if (!confirmed) return createSettingsError(createMessage('permissions.error.autoNotEnabled'), 'cancelled');
    }
    const result = await toolPolicyStore.setMode(mode);
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
    const preview = normalizePermissionRule({ ...candidate, id: 'preview' });
    if (!preview) return createSettingsError(createMessage('permissions.error.invalidRule'));
    if (preview.effect === PERMISSION_RULE_EFFECTS.ALLOW) {
      const confirmed = await confirmNatively(allowRuleDialog(preview, createTranslator(getLocale())));
      if (!confirmed) return createSettingsError(createMessage('permissions.error.ruleNotCreated'), 'cancelled');
    }
    const result = await toolPolicyStore.addRule(candidate);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_RULE, async (event, ruleId) => {
    const id = typeof ruleId === 'string' ? ruleId.trim() : '';
    if (!id) return createSettingsError(createMessage('permissions.error.ruleIdMissing'));
    const rule = await toolPolicyStore.findRule(id);
    if (!rule) return createSettingsError(createMessage('permissions.error.ruleNotFound'));
    if (rule.effect === PERMISSION_RULE_EFFECTS.DENY) {
      const confirmed = await confirmNatively(removeDenyRuleDialog(rule, createTranslator(getLocale())));
      if (!confirmed) return createSettingsError(createMessage('permissions.error.denyNotRemoved'), 'cancelled');
    }
    const result = await toolPolicyStore.removeRule(id);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, async (event, rawPatterns) => {
    if (!Array.isArray(rawPatterns)) return createSettingsError(createMessage('permissions.error.patternsExpected'));
    const result = await toolPolicyStore.setSensitivePathPatterns(normalizeSensitivePathPatterns(rawPatterns));
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

  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES, async (event) => {
    const root = getActiveWorkspaceRoot();
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const result = await toolPolicyStore.resetWorkspaceRules(root);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  // The sandbox of the execution tools, per workspace (#357). Off is a
  // loosening and goes through the native dialog; on never asks. The root is
  // the active one from main, never a path the renderer names.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, async (event, enabled) => {
    if (typeof enabled !== 'boolean') return createSettingsError(createMessage('permissions.error.invalidSandboxSetting'));
    const root = getActiveWorkspaceRoot();
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    if (!enabled) {
      const confirmed = await confirmNatively(sandboxOffDialog(root, createTranslator(getLocale())));
      if (!confirmed) return createSettingsError(createMessage('permissions.error.sandboxNotSwitchedOff'), 'cancelled');
    }
    const result = await toolPolicyStore.setWorkspaceSandbox(root, enabled);
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
    if (mode === TOOL_PERMISSION_MODES.AUTO && current !== TOOL_PERMISSION_MODES.AUTO) {
      if (!(await canStoreAuto())) return createSettingsError(createMessage('permissions.error.autoNeedsEncryption'));
      const confirmed = await confirmNatively(workspaceAutoDialog(root, createTranslator(getLocale())));
      if (!confirmed) return createSettingsError(createMessage('permissions.error.workspaceAutoNotSet'), 'cancelled');
    }
    const result = await toolPolicyStore.setWorkspaceMode(root, mode);
    if (!result.ok) return createSettingsError(result.error);
    if (!event.sender.isDestroyed?.()) event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    return { ...createSettingsOk(), workspaceMode: mode };
  });

  // Program allowances (#408). The renderer sends what the dialog holds; main
  // resolves the program and checks the folders on its own, and asks natively
  // before anything widens the sandbox.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, async (event, raw) => {
    if (!programAllowances) return createSettingsError(createMessage('permissions.allowance.error.unavailable'));
    const data = raw && typeof raw === 'object' ? raw : {};
    const prepared = await programAllowances.prepareEntry(data);
    if (!prepared.ok) return createSettingsError(prepared.error);
    const entry = prepared.entry;
    const replacePath = normalizeAllowancePath(data.previousPath);
    const state = await toolPolicyStore.read();
    const stored = Array.isArray(state.programAllowances) ? state.programAllowances : [];
    const previous = stored.find((other) => other.path === (replacePath || entry.path))
      || stored.find((other) => other.path === entry.path)
      || null;
    if (!isNarrowing(previous, entry)) {
      const confirmed = await confirmNatively(programAllowanceDialog(entry, createTranslator(getLocale()), homeDir));
      if (!confirmed) return createSettingsError(createMessage('permissions.allowance.error.notSaved'), 'cancelled');
    }
    const result = await toolPolicyStore.setProgramAllowance(entry, { replacePath });
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return { ...createSettingsOk(), entry };
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_PROGRAM_ALLOWANCE, async (event, rawPath) => {
    const programPath = normalizeAllowancePath(rawPath);
    if (!programPath) return createSettingsError(createMessage('permissions.allowance.error.invalid'));
    const result = await toolPolicyStore.removeProgramAllowance(programPath);
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
    const result = await toolPolicyStore.resetAll();
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
    const confirmed = await confirmNatively(commandRuleDialog(rule, createTranslator(getLocale())));
    if (!confirmed) return { error: createMessage('approval.error.alwaysNotConfirmed'), code: 'cancelled' };
    // The run may have ended while the dialog was open; then nothing is kept.
    if (!approvals.getPendingRequest?.(event.sender.id, requestId)) {
      return { error: createMessage('approval.error.noPending') };
    }
    const stored = await toolPolicyStore.addRule(request.commandRule);
    if (!stored.ok) return { error: stored.error };
    if (event.sender && typeof event.sender.send === 'function' && !event.sender.isDestroyed?.()) {
      event.sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    }
    return { ruleId: stored.ruleId };
  }

  ipcMain.handle(REQ.TOOL_APPROVAL_RESPOND, async (event, payload) => {
    const response = normalizeToolApprovalResponse(payload);
    if (!response) return createSettingsError(createMessage('approval.error.invalidResponse'));
    if (response.response === APPROVAL_RESPONSES.ALLOW_ALWAYS) {
      const remembered = await rememberCommand(event, response);
      if (remembered.error) return createSettingsError(remembered.error, remembered.code);
      response.ruleId = remembered.ruleId;
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
  programAllowanceDialog,
};
