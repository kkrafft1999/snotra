'use strict';

/**
 * A card waiting while Snotra is in the background or in another chat (#792,
 * step 5). The renderer knows when and writes the words; main shows the
 * notification and closes it again.
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
