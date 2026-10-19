'use strict';

/**
 * A card waiting while Snotra is in the background or in another chat (#792,
 * step 5). The renderer knows when and writes the words; main shows the
 * notification and closes it again.
 *
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {ReturnType<typeof import('../services/approval-notifier').createApprovalNotifier>} deps.approvalNotifier
 * @param {Record<string, string>} deps.REQ
 */
function registerApprovalNotificationHandlers({ ipcMain, approvalNotifier, REQ }) {
  ipcMain.handle(REQ.APPROVAL_NOTIFICATION_SHOW, async (_event, payload) => ({
    ok: true,
    shown: await approvalNotifier.show(payload && typeof payload === 'object' ? payload : {}),
  }));
  ipcMain.handle(REQ.APPROVAL_NOTIFICATION_CLOSE, async (_event, payload) => ({
    ok: true,
    closed: approvalNotifier.close(payload?.requestId),
  }));
}

module.exports = { registerApprovalNotificationHandlers };
