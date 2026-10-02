/**
 * Dateisystem-IPC mit Workspace-Sandbox (Explorer + Vorschau).
 *
 * Lists every member `adapters/filesystem-ipc-adapter.js` provides (#650);
 * `test/filesystem-port-typedef.test.js` holds the two together.
 *
 * @typedef {Object} FilesystemPort
 * @property {(dirPath: string, options?: {showHidden?: boolean}) => Promise<{entries: Array, hidden: number}>} readDirectory
 *   `hidden` counts the entries cut off after the first READ_DIRECTORY_MAX_ENTRIES (#76);
 *   it has nothing to do with `showHidden`, which lists dot files as well (#436).
 * @property {(sourcePath: string, destDir: string) => Promise<object>} moveItem
 * @property {(sourcePaths: string[], destDir: string) => Promise<object>} inspectImport
 *   Counts an import from outside the workspace without writing (#101). The sources
 *   are what the preload resolved from dropped File objects, never a path the page
 *   names (#646); only the target is bound to the workspace.
 * @property {(sourcePaths: string[], destDir: string) => Promise<object>} importItems
 *   Copies them, all or nothing; the handler confirms natively before.
 * @property {(options?: {showHidden?: boolean}) => Promise<{entries: Array, truncated: boolean, error?: string}>} listWorkspacePaths
 * @property {(filePath: string) => Promise<{absPath: string} | {error: string}>} resolveCheckedWorkspacePath
 *   Checks an absolute path against the real workspace (realpath), exactly as sent.
 *   Not fs-service's `resolveWorkspacePath`, which joins a relative path lexically.
 * @property {(filePath: string) => Promise<object>} readFilePreview
 * @property {(imagePath: string) => Promise<object>} readWorkspaceImage
 *   Relative or absolute, as the model wrote it (#244).
 * @property {(pdfPath: string) => Promise<object>} readWorkspacePdf
 */

module.exports = {};
