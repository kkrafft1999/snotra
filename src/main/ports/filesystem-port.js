/**
 * Dateisystem-IPC mit Workspace-Sandbox (Explorer + Vorschau).
 *
 * @typedef {Object} FilesystemPort
 * @property {(dirPath: string, options?: {showHidden?: boolean}) => Promise<{entries: Array, hidden: number}>} readDirectory
 *   `hidden` counts the entries cut off after the first READ_DIRECTORY_MAX_ENTRIES (#76);
 *   it has nothing to do with `showHidden`, which lists dot files as well (#436).
 * @property {(sourcePath: string, destDir: string) => Promise<object>} moveItem
 * @property {(filePath: string) => Promise<object>} readFilePreview
 */

module.exports = {};
