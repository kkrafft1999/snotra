'use strict';

function registerUpdateHandlers({ ipcMain, updates, REQ, PUSH, getMainWindow }) {
  ipcMain.handle(REQ.UPDATE_GET_VERSION, async () => ({
    version: updates.getCurrentVersion(),
  }));

  // respectIgnored=false: ein manueller Check soll auch eine zuvor
  // uebersprungene Version wieder anzeigen.
  ipcMain.handle(REQ.UPDATE_CHECK, async () =>
    updates.checkForUpdate({ respectIgnored: false }));

  ipcMain.handle(REQ.UPDATE_IGNORE_VERSION, async (_event, version) =>
    updates.ignoreVersion(version));

  // Fortschritt geht an genau das Fenster, das den Download angestossen hat.
  // Ist es beim Eintreffen schon zu, wird nichts gesendet — ein zerstoertes
  // webContents wuerde sonst werfen und den Download mitreissen.
  ipcMain.handle(REQ.UPDATE_DOWNLOAD, async (event) => updates.downloadUpdate({
    onProgress: (progress) => {
      const sender = event.sender;
      if (!sender || sender.isDestroyed()) return;
      sender.send(PUSH.UPDATE_PROGRESS, progress);
    },
  }));

  ipcMain.handle(REQ.UPDATE_CANCEL_DOWNLOAD, async () => updates.cancelDownload());

  ipcMain.handle(REQ.UPDATE_DISCARD_DOWNLOAD, async () => updates.discardDownload());

  // Gelingt die Installation, beendet sich die App fuer den Neustart — die
  // Antwort erreicht den Renderer dann gar nicht mehr. Nur der Fehlerfall
  // kommt zurueck, und dann laeuft die alte Version unveraendert weiter.
  ipcMain.handle(REQ.UPDATE_INSTALL, async () => {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const result = await updates.installUpdate();
    if (!result.ok && win && !win.isDestroyed()) win.focus();
    return result;
  });
}

module.exports = { registerUpdateHandlers };
