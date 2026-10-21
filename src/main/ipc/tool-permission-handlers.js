'use strict';

/**
 * The channels of the tool permissions (#66). What a change needs, which
 * confirmation it asks for and what it voids is decided in
 * `services/tool-permission-service.js` (#1006); these handlers parse,
 * delegate, show the native folder picker and tell the asking window to read
 * the state again.
 */

const { createSettingsOk, createSettingsError } = require('../../shared/contracts/settings');
const { createMessage } = require('../../shared/contracts/message');
const { createTranslator } = require('../../shared/i18n');

/**
 * @typedef {import('electron').WebContents} Sender
 * @typedef {ReturnType<typeof import('../services/tool-permission-service').createToolPermissionService>} ToolPermissionService
 */

/**
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {ToolPermissionService} deps.permissions
 * @param {Pick<ReturnType<typeof import('../adapters/tool-approval-adapter').createToolApprovalAdapter>, 'subscribe'>} deps.approvals
 * @param {Pick<import('electron').Dialog, 'showOpenDialog'>|null} [deps.dialog]
 * @param {() => import('electron').BrowserWindow|null} [deps.getMainWindow]
 * @param {() => unknown} [deps.getLocale]
 * @param {string} [deps.homeDir]
 * @param {Record<string, string>} deps.REQ
 * @param {Record<string, string>} deps.PUSH
 */
function registerToolPermissionHandlers({
  ipcMain,
  permissions,
  approvals,
  // Only the folder picker of program allowances (#408); confirmations go
  // through the user-confirmation port inside the service.
  dialog = null,
  getMainWindow = () => null,
  // Interface language for the native folder picker (#353), read afresh each time.
  getLocale = () => undefined,
  homeDir = '',
  REQ,
  PUSH,
}) {
  if (!permissions || !approvals) {
    throw new Error('registerToolPermissionHandlers requires the permission service and approvals.');
  }

  /**
   * Tells the window that asked to read the permission state again.
   *
   * @param {Sender|null|undefined} sender
   */
  const notifier = (sender) => () => {
    if (sender && typeof sender.send === 'function' && !sender.isDestroyed?.()) {
      sender.send(PUSH.TOOL_PERMISSIONS_CHANGED, {});
    }
  };

  ipcMain.handle(REQ.TOOL_PERMISSIONS_GET_STATE, async () => permissions.buildState());
  ipcMain.handle(REQ.TOOL_PERMISSIONS_GET_SECURITY_OVERVIEW, async () => permissions.buildSecurityOverview());
  ipcMain.handle(REQ.TOOL_PERMISSIONS_GET_SANDBOX_OVERVIEW, async () => permissions.buildSandboxOverview());

  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_MODE, async (event, rawMode) =>
    permissions.setMode(notifier(event.sender), rawMode));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_ADD_RULE, async (event, rawRule) =>
    permissions.addRule(notifier(event.sender), rawRule));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_RULE, async (event, ruleId) =>
    permissions.removeRule(notifier(event.sender), ruleId));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_SENSITIVE_PATHS, async (event, rawPatterns) =>
    permissions.setSensitivePaths(notifier(event.sender), rawPatterns));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_CLEAR_SESSION_GRANTS, async (event) =>
    permissions.clearSessionGrants(notifier(event.sender)));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_REVOKE_SESSION_GRANT, async (event, grantId) =>
    permissions.revokeSessionGrant(notifier(event.sender), grantId));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_WORKSPACE_HOST, async (event, rawHost, rawRoot) =>
    permissions.removeWorkspaceHost(notifier(event.sender), rawHost, rawRoot));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_RULES, async (event) =>
    permissions.resetWorkspaceRules(notifier(event.sender)));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX, async (event, enabled, rawRoot) =>
    permissions.setWorkspaceSandbox(notifier(event.sender), enabled, rawRoot));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_WORKSPACE_MODE, async (event, rawMode) =>
    permissions.setWorkspaceMode(notifier(event.sender), rawMode));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE, async (event, raw) =>
    permissions.setProgramAllowance(notifier(event.sender), raw));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_PROGRAM_ALLOWANCE, async (event, rawPath, rawScope) =>
    permissions.removeProgramAllowance(notifier(event.sender), rawPath, rawScope));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_ADD_HOSTS, async (event, raw) =>
    permissions.addHosts(notifier(event.sender), raw));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_REMOVE_GLOBAL_HOST, async (event, rawHost) =>
    permissions.removeGlobalHost(notifier(event.sender), rawHost));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_SET_NEW_WORKSPACE_SANDBOX, async (event, enabled) =>
    permissions.setNewWorkspaceSandbox(notifier(event.sender), enabled));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_WORKSPACE_SANDBOX, async (event, rawRoot) =>
    permissions.resetWorkspaceSandbox(notifier(event.sender), rawRoot));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_SANDBOX_EVERYWHERE, async (event) =>
    permissions.resetSandboxEverywhere(notifier(event.sender)));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESOLVE_PROGRAM, async (_event, text) => permissions.resolveProgram(text));
  ipcMain.handle(REQ.TOOL_PERMISSIONS_RESET_ALL, async (event) => permissions.resetAll(notifier(event.sender)));

  // A folder for the allowance, picked natively and checked at once.
  ipcMain.handle(REQ.TOOL_PERMISSIONS_CHOOSE_ALLOWANCE_FOLDER, async () => {
    if (!permissions.canCheckAllowanceFolders() || !dialog || typeof dialog.showOpenDialog !== 'function') {
      return createSettingsError(createMessage('permissions.allowance.error.unavailable'));
    }
    const t = createTranslator(getLocale());
    /** @type {import('electron').OpenDialogOptions} */
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
    return permissions.checkAllowanceFolder(result.filePaths[0]);
  });

  // Approval cards: subscribing, answering, the open requests.
  ipcMain.handle(REQ.TOOL_APPROVAL_SUBSCRIBE, async (event) => {
    approvals.subscribe(event.sender.id, event.sender);
    return createSettingsOk();
  });
  ipcMain.handle(REQ.TOOL_APPROVAL_RESPOND, async (event, payload) =>
    permissions.respondToApproval(event.sender.id, notifier(event.sender), payload));
  ipcMain.handle(REQ.TOOL_APPROVAL_LIST_PENDING, async (event) => permissions.listPendingApprovals(event.sender.id));
}

module.exports = { registerToolPermissionHandlers };
