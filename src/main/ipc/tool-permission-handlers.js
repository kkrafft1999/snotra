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
 */

const {
  TOOL_PERMISSION_MODES,
  PERMISSION_RULE_EFFECTS,
  PERMISSION_RULE_SCOPES,
  PERMISSION_DENIAL_REASONS,
  normalizeToolPermissionMode,
  normalizePermissionRule,
  normalizeSensitivePathPatterns,
  normalizeToolApprovalResponse,
} = require('../../shared/contracts/tool-permissions');
const { createSettingsOk, createSettingsError } = require('../../shared/contracts/settings');
const { createMessage } = require('../../shared/contracts/message');
const { createTranslator } = require('../../shared/i18n');
const { menuPath } = require('../../shared/i18n/ui-quotes');

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
      place: menuPath(t.locale, 'settings.permissions'),
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

  async function buildState() {
    const state = await toolPolicyStore.read();
    const root = getActiveWorkspaceRoot();
    return {
      mode: state.mode,
      integrity: state.integrity,
      encryptionAvailable: state.encryptionAvailable,
      legacyWriteMigrated: state.legacyWriteMigrated === true,
      globalRules: state.globalRules,
      workspaceRules: root && state.workspaceRules[root] ? state.workspaceRules[root] : [],
      workspaceRoot: root,
      sensitivePathPatterns: state.sensitivePathPatterns,
      sessionGrantCount: sessionGrants.count(),
      policyVersion: state.policyVersion,
    };
  }

  ipcMain.handle(REQ.TOOL_PERMISSIONS_GET_STATE, async () => buildState());

  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_MODE, async (event, rawMode) => {
    const mode = normalizeToolPermissionMode(rawMode);
    if (mode !== rawMode) return createSettingsError(createMessage('permissions.error.unknownMode'));
    if (mode === TOOL_PERMISSION_MODES.AUTO) {
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

  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES, async (event) => {
    const root = getActiveWorkspaceRoot();
    if (!root) return createSettingsError(createMessage('permissions.error.noWorkspace'));
    const result = await toolPolicyStore.resetWorkspaceRules(root);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
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

  ipcMain.handle(REQ.TOOL_APPROVAL_RESPOND, async (event, payload) => {
    const response = normalizeToolApprovalResponse(payload);
    if (!response) return createSettingsError(createMessage('approval.error.invalidResponse'));
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
};
