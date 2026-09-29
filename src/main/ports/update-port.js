/**
 * Selbst-Update (Issue #232): pruefen, laden, installieren — drei getrennte
 * Schritte, damit der Nutzer jeden einzeln bestaetigt und abbrechen kann.
 *
 * @typedef {Object} UpdatePort
 * @property {() => string} getCurrentVersion
 * @property {(options?: { respectIgnored?: boolean }) => Promise<object>} checkForUpdate
 * @property {(version: string) => Promise<object>} ignoreVersion
 * @property {(options?: { onProgress?: (p: { receivedBytes: number, totalBytes: number }) => void })
 *            => Promise<{ ok: boolean, filePath?: string, canceled?: boolean, error?: string }>} downloadUpdate
 * @property {() => { ok: boolean }} cancelDownload
 * @property {() => Promise<{ ok: boolean }>} discardDownload
 * @property {() => Promise<{ ok: boolean, relaunching?: boolean, error?: string }>} installUpdate
 * @property {() => Promise<{ version: string, error: string, logFile: string } | null>} takeInstallFailure
 *            A swap that failed after the app had quit (#442), reported once.
 */

module.exports = {};
