/**
 * Dateisystem-IPC mit Workspace-Sandbox (Explorer + Vorschau).
 *
 * Lists every member `adapters/filesystem-ipc-adapter.js` provides (#650);
 * `test/filesystem-port-typedef.test.js` holds the two together.
 *
 * @typedef {Object} FilesystemPort
 * @property {(dirPath: string, options?: {showHidden?: boolean}) => Promise<{entries: Array, hidden: number, unreadable?: 'permission'|'missing'|'refused'|'failed'}>} readDirectory
 *   `hidden` counts the entries cut off after the first READ_DIRECTORY_MAX_ENTRIES (#76);
 *   it has nothing to do with `showHidden`, which lists dot files as well (#436).
 *   `unreadable` is set, with no entries, when the folder could not be listed (#639):
 *   no permission (EACCES, EPERM), gone (ENOENT, ENOTDIR), outside the workspace, or
 *   anything else. Without it an empty listing is an empty folder.
 * @property {(sourcePath: string, destDir: string) => Promise<object>} moveItem
 * @property {(parentDir: string, name: string, kind: 'file'|'directory') => Promise<{ok: true, path: string}|{error: string, reason: string, character?: string}>} createItem
 *   An empty file or folder from the tree (#349). Never over an existing name. `reason`
 *   is a code of ITEM_NAME_REASONS or ITEM_FAILURE_REASONS (`shared/contracts/item-name.js`).
 * @property {(itemPath: string, newName: string) => Promise<{ok: true, path: string, unchanged?: boolean}|{error: string, reason: string, character?: string}>} renameItem
 *   In its own folder; a case-only rename on APFS or NTFS goes through. The workspace
 *   folder itself is refused with reason 'root'.
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
 * @property {(filePath: string) => Promise<{content: string, size: number, modified: number}|{error: string, reason: 'refused'|'missing'|'permission'|'too-large'|'failed', size?: number}>} readFilePreview
 *   A failed read carries `reason` (#641), the same codes as `unreadable` above plus
 *   'too-large' (over the 1 MB preview limit, with the file's `size`). `error` is the
 *   system's message, for the log; the renderer words the reason itself.
 * @property {(imagePath: string) => Promise<object>} readWorkspaceImage
 *   Relative or absolute, as the model wrote it (#244).
 * @property {(pdfPath: string) => Promise<object>} readWorkspacePdf
 */

module.exports = {};
