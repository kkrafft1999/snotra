function registerFsHandlers({ ipcMain, filesystem, REQ }) {
  ipcMain.handle(REQ.FS_READ_DIRECTORY, async (_event, dirPath) =>
    filesystem.readDirectory(dirPath));

  ipcMain.handle(REQ.FS_MOVE_ITEM, async (_event, sourcePath, destDir) =>
    filesystem.moveItem(sourcePath, destDir));

  ipcMain.handle(REQ.FS_READ_FILE, async (_event, filePath) =>
    filesystem.readFilePreview(filePath));

  ipcMain.handle(REQ.FS_LIST_WORKSPACE_PATHS, async () =>
    filesystem.listWorkspacePaths());
}

module.exports = { registerFsHandlers };
