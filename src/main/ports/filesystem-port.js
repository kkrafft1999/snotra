/**
 * Dateisystem-IPC mit Workspace-Sandbox (Explorer + Vorschau).
 *
 * @typedef {Object} FilesystemPort
 * @property {(dirPath: string, options?: {showHidden?: boolean}) => Promise<{entries: Array, hidden: number, unreadable?: 'permission'|'missing'|'refused'|'failed'}>} readDirectory
 *   `hidden` counts the entries cut off after the first READ_DIRECTORY_MAX_ENTRIES (#76);
 *   it has nothing to do with `showHidden`, which lists dot files as well (#436).
 *   `unreadable` is set, with no entries, when the folder could not be listed (#639):
 *   no permission (EACCES, EPERM), gone (ENOENT, ENOTDIR), outside the workspace, or
 *   anything else. Without it an empty listing is an empty folder.
 * @property {(sourcePath: string, destDir: string) => Promise<object>} moveItem
 * @property {(filePath: string) => Promise<{content: string, size: number, modified: number}|{error: string, reason: 'refused'|'missing'|'permission'|'too-large'|'failed', size?: number}>} readFilePreview
 *   A failed read carries `reason` (#641), the same codes as `unreadable` above plus
 *   'too-large' (over the 1 MB preview limit, with the file's `size`). `error` is the
 *   system's message, for the log; the renderer words the reason itself.
 */

module.exports = {};
