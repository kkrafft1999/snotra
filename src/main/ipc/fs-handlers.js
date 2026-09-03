function registerFsHandlers({ ipcMain, filesystem, REQ, PUSH = null, fileContextMenu = null, getMainWindow = () => null }) {
  ipcMain.handle(REQ.FS_READ_DIRECTORY, async (_event, dirPath) =>
    filesystem.readDirectory(dirPath));

  ipcMain.handle(REQ.FS_MOVE_ITEM, async (_event, sourcePath, destDir) =>
    filesystem.moveItem(sourcePath, destDir));

  ipcMain.handle(REQ.FS_READ_FILE, async (_event, filePath) =>
    filesystem.readFilePreview(filePath));

  ipcMain.handle(REQ.FS_LIST_WORKSPACE_PATHS, async () =>
    filesystem.listWorkspacePaths());

  // Issue #58: Kontextmenü im Dateibaum. Der Pfad wird wie bei allen fs-Kanälen
  // gegen den aktiven Workspace geprüft, bevor er an die Shell geht.
  ipcMain.handle(REQ.FS_SHOW_FILE_CONTEXT_MENU, async (_event, filePath) => {
    if (!fileContextMenu) return { error: 'Kontextmenü nicht verfügbar.' };
    const { absPath, error } = await filesystem.resolveWorkspacePath(filePath);
    if (error) return { error };
    const win = getMainWindow();
    fileContextMenu.popup(absPath, win, {
      // Nach dem Löschen (Papierkorb) den Baum im Renderer nachziehen.
      onDeleted: (deletedPath) => {
        if (PUSH && win && !win.isDestroyed()) {
          win.webContents.send(PUSH.FS_ITEM_DELETED, { path: deletedPath });
        }
      },
    });
    return { ok: true };
  });
}

module.exports = { registerFsHandlers };
