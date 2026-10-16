'use strict';

/**
 * The notice channel to the window (#1001, part of #978). Notices posted
 * before the window exists wait in `notices` until the renderer lists them;
 * later ones are pushed as they come. The renderer names a notice only by its
 * id — which file to show in the file manager is decided here.
 */
function registerNoticeHandlers({ ipcMain, notices, REQ, PUSH, getMainWindow, shell = null, platform = process.platform }) {
  notices.subscribe((event) => {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!win || win.isDestroyed()) return;
    if (event.type === 'posted') win.webContents.send(PUSH.NOTICE_POSTED, event.notice);
    else if (event.type === 'withdrawn') win.webContents.send(PUSH.NOTICE_WITHDRAWN, { id: event.id });
  });

  // The platform names the file manager on the reveal button — a fact, not
  // text: the renderer words it.
  ipcMain.handle(REQ.NOTICES_LIST, async () => ({ notices: notices.list(), platform }));

  ipcMain.handle(REQ.NOTICES_DISMISS, async (_event, id) => ({
    ok: typeof id === 'string' && notices.dismiss(id),
  }));

  ipcMain.handle(REQ.NOTICES_REVEAL, async (_event, id) => {
    const notice = typeof id === 'string' ? notices.get(id) : null;
    if (!notice?.location || typeof shell?.showItemInFolder !== 'function') return { ok: false };
    shell.showItemInFolder(notice.location);
    return { ok: true };
  });
}

module.exports = { registerNoticeHandlers };
