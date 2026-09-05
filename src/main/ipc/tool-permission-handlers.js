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

const AUTO_MODE_DIALOG = Object.freeze({
  type: 'warning',
  title: 'Auto / Vollzugriff aktivieren?',
  message: 'Auto / Vollzugriff aktivieren?',
  detail:
    'Tools dürfen Dateien automatisch lesen und verändern sowie sensible Workspace-Inhalte an den ' +
    'gewählten Provider senden. Künftig gilt dies auch für freigeschaltete externe Tools. Es gibt keine ' +
    'Rückfragen zu Tool-Aufrufen. Workspace-Grenzen, gesperrte Aktionen und der Schutz von ' +
    'Snotra-Schlüsseln bleiben aktiv.',
  buttons: ['Auto aktivieren', 'Abbrechen'],
  defaultId: 1,
  cancelId: 1,
});

function allowRuleDialog(rule) {
  const scope = rule.scope === PERMISSION_RULE_SCOPES.GLOBAL ? 'Alle Workspaces' : `Workspace ${rule.root}`;
  const subject = rule.tool ? `Tool ${rule.tool}` : `Klasse ${rule.riskClass}`;
  return {
    type: 'warning',
    title: 'Dauerhafte Erlaubnis anlegen?',
    message: 'Dauerhafte Erlaubnis anlegen?',
    detail:
      `${subject} darf künftig ohne Rückfrage auf „${rule.pathPattern}“ zugreifen (${scope}). ` +
      'Die Regel gilt im Modus „Intelligent“ bis du sie unter Einstellungen › Tools löschst.',
    buttons: ['Erlaubnis anlegen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
  };
}

function removeDenyRuleDialog(rule) {
  const subject = rule.tool ? `Tool ${rule.tool}` : `Klasse ${rule.riskClass}`;
  return {
    type: 'warning',
    title: 'Sperre löschen?',
    message: 'Sperre löschen?',
    detail: `Die Sperre für ${subject} auf „${rule.pathPattern}“ wird entfernt. Danach entscheidet wieder der Modus.`,
    buttons: ['Sperre löschen', 'Abbrechen'],
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
    if (mode !== rawMode) return createSettingsError('Unbekannter Modus.');
    if (mode === TOOL_PERMISSION_MODES.AUTO) {
      const confirmed = await confirmNatively(AUTO_MODE_DIALOG);
      if (!confirmed) return createSettingsError('Auto nicht aktiviert.', 'cancelled');
    }
    const result = await toolPolicyStore.setMode(mode);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return { ...createSettingsOk(), mode: result.mode };
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_ADD_RULE, async (event, rawRule) => {
    const candidate = rawRule && typeof rawRule === 'object' ? { ...rawRule } : null;
    if (!candidate) return createSettingsError('Ungültige Regel.');
    // Workspace-Regeln binden immer den aktiven Root aus dem Main, nie einen
    // vom Renderer gelieferten Pfad (Konzept §5/§7).
    if (candidate.scope === PERMISSION_RULE_SCOPES.WORKSPACE) {
      const root = getActiveWorkspaceRoot();
      if (!root) return createSettingsError('Kein Workspace geöffnet.');
      candidate.root = root;
    } else {
      candidate.scope = PERMISSION_RULE_SCOPES.GLOBAL;
      delete candidate.root;
    }
    delete candidate.id;
    const preview = normalizePermissionRule({ ...candidate, id: 'preview' });
    if (!preview) return createSettingsError('Ungültige Regel.');
    if (preview.effect === PERMISSION_RULE_EFFECTS.ALLOW) {
      const confirmed = await confirmNatively(allowRuleDialog(preview));
      if (!confirmed) return createSettingsError('Regel nicht angelegt.', 'cancelled');
    }
    const result = await toolPolicyStore.addRule(candidate);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_RULE, async (event, ruleId) => {
    const id = typeof ruleId === 'string' ? ruleId.trim() : '';
    if (!id) return createSettingsError('Regel-ID fehlt.');
    const rule = await toolPolicyStore.findRule(id);
    if (!rule) return createSettingsError('Regel nicht gefunden.');
    if (rule.effect === PERMISSION_RULE_EFFECTS.DENY) {
      const confirmed = await confirmNatively(removeDenyRuleDialog(rule));
      if (!confirmed) return createSettingsError('Sperre nicht gelöscht.', 'cancelled');
    }
    const result = await toolPolicyStore.removeRule(id);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, async (event, rawPatterns) => {
    if (!Array.isArray(rawPatterns)) return createSettingsError('Liste von Mustern erwartet.');
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
    if (!root) return createSettingsError('Kein Workspace geöffnet.');
    const result = await toolPolicyStore.resetWorkspaceRules(root);
    if (!result.ok) return createSettingsError(result.error);
    afterPolicyChange(event.sender);
    return createSettingsOk();
  });

  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_ALL, async (event) => {
    const result = await toolPolicyStore.resetAll();
    if (!result.ok) return createSettingsError(result.error);
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
    if (!response) return createSettingsError('Ungültige Antwort.');
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
  AUTO_MODE_DIALOG,
  allowRuleDialog,
  removeDenyRuleDialog,
};
