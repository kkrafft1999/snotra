'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWindowPush } = require('../src/main/ipc/window-push');
const { registerApprovalNotificationHandlers } = require('../src/main/ipc/approval-notification-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

function fakeWindow({ destroyed = false } = {}) {
  const sent = [];
  return { sent, isDestroyed: () => destroyed, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
}

test('a push reaches the window, with an empty payload by default', () => {
  const win = fakeWindow();
  const push = createWindowPush(() => win);
  assert.equal(push('a:changed'), true);
  assert.equal(push('b:changed', { x: 1 }), true);
  assert.deepEqual(win.sent, [['a:changed', {}], ['b:changed', { x: 1 }]]);
});

test('without a window, or with a destroyed one, a push is dropped', () => {
  assert.equal(createWindowPush(() => null)('a:changed'), false);
  const win = fakeWindow({ destroyed: true });
  assert.equal(createWindowPush(() => win)('a:changed'), false);
  assert.deepEqual(win.sent, []);
});

test('the approval notification channels show and close through the notifier (#792)', async () => {
  const ipcMain = createMockIpcMain();
  const shown = [];
  registerApprovalNotificationHandlers({
    ipcMain,
    REQ,
    approvalNotifier: {
      show: async (payload) => {
        shown.push(payload);
        return true;
      },
      close: (requestId) => requestId === 'r1',
    },
  });

  assert.deepEqual(await ipcMain.invoke(REQ.APPROVAL_NOTIFICATION_SHOW, { requestId: 'r1' }), { ok: true, shown: true });
  assert.deepEqual(await ipcMain.invoke(REQ.APPROVAL_NOTIFICATION_SHOW, 'not an object'), { ok: true, shown: true });
  assert.deepEqual(shown, [{ requestId: 'r1' }, {}]);
  assert.deepEqual(await ipcMain.invoke(REQ.APPROVAL_NOTIFICATION_CLOSE, { requestId: 'r1' }), { ok: true, closed: true });
  assert.deepEqual(await ipcMain.invoke(REQ.APPROVAL_NOTIFICATION_CLOSE, null), { ok: true, closed: false });
});
