'use strict';

function createFilesystemIpcAdapter({ fsService, getActiveWorkspaceRoot }) {
  async function boundPath(absPath) {
    const workspaceRoot = getActiveWorkspaceRoot();
    return fsService.assertPathAccessibleInWorkspace(workspaceRoot, absPath);
  }

  return {
    async readDirectory(dirPath) {
      const { absPath, error } = await boundPath(dirPath);
      if (error) {
        console.error('readDirectory denied:', error);
        return [];
      }
      try {
        return await fsService.readDirectory(absPath);
      } catch (err) {
        console.error('readDirectory error:', err.message);
        return [];
      }
    },
    async moveItem(sourcePath, destDir) {
      const source = await boundPath(sourcePath);
      if (source.error) return { error: source.error };
      const dest = await boundPath(destDir);
      if (dest.error) return { error: dest.error };
      try {
        return await fsService.moveItem(source.absPath, dest.absPath);
      } catch (err) {
        return { error: err.message };
      }
    },
    // Pfadliste für die @-Vervollständigung; immer relativ zum aktiven Workspace,
    // der Renderer übergibt bewusst keinen Pfad (kein Ausbruch aus dem Root möglich).
    async listWorkspacePaths() {
      const workspaceRoot = getActiveWorkspaceRoot();
      if (!workspaceRoot) {
        return { entries: [], truncated: false, error: 'Kein Arbeitsordner geöffnet.' };
      }
      try {
        return await fsService.listWorkspacePaths(workspaceRoot);
      } catch (err) {
        return { entries: [], truncated: false, error: err.message };
      }
    },
    // Nur Pfadprüfung, keine Dateizugriffe: der Aufrufer (z. B. Kontextmenü)
    // arbeitet danach mit dem bereinigten absoluten Pfad weiter.
    async resolveWorkspacePath(filePath) {
      return boundPath(filePath);
    },
    async readFilePreview(filePath) {
      const { absPath, error } = await boundPath(filePath);
      if (error) return { error };
      try {
        return await fsService.readFilePreview(absPath);
      } catch (err) {
        return { error: err.message };
      }
    },
  };
}

module.exports = {
  createFilesystemIpcAdapter,
};
