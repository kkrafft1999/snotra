/**
 * Dateisystem-IPC mit Workspace-Sandbox (Explorer + Vorschau).
 *
 * @typedef {Object} FilesystemPort
 * @property {(dirPath: string) => Promise<{entries: Array, hidden: number}>} readDirectory
 *   `hidden` counts the entries cut off after the first READ_DIRECTORY_MAX_ENTRIES (#76).
 * @property {(sourcePath: string, destDir: string) => Promise<object>} moveItem
 * @property {(filePath: string) => Promise<object>} readFilePreview
 */

module.exports = {};
