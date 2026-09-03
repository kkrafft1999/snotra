/**
 * Zuletzt geöffnete Projektordner.
 *
 * @typedef {Object} WorkspaceFolderStorePort
 * @property {() => Promise<string|null>} getValidatedLastFolder
 * @property {(folderPath: string) => Promise<void>} persistLastFolder
 * @property {() => Promise<string[]>} getValidatedFolderHistory
 * @property {(folderPath: string) => Promise<boolean>} removeFolderFromHistory
 */

module.exports = {};
