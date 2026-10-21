/**
 * Selbst-Update (Issue #232): pruefen, laden, installieren — drei getrennte
 * Schritte, damit der Nutzer jeden einzeln bestaetigt und abbrechen kann.
 *
 * @typedef {string | import('../../shared/contracts/message').Message} UpdateError
 *            A message the dialog words, or what the network or the file system said, quoted.
 *
 * @typedef {Object} UpdatePort
 * @property {() => string} getCurrentVersion
 * @property {(options?: { respectIgnored?: boolean, signal?: AbortSignal }) => Promise<{ updateAvailable?: boolean } & Object<string, unknown>>} checkForUpdate
 * @property {(version: unknown) => Promise<{ ok: boolean, error?: UpdateError }>} ignoreVersion
 * @property {(options?: { onProgress?: (p: { receivedBytes: number, totalBytes: number }) => void })
 *            => Promise<{ ok: boolean, filePath?: string, canceled?: boolean, manualOnly?: boolean,
 *              releaseUrl?: string, error?: UpdateError }>} downloadUpdate
 * @property {() => { ok: boolean }} cancelDownload
 * @property {() => Promise<{ ok: boolean }>} discardDownload
 * @property {() => Promise<{ ok: boolean, relaunching?: boolean, logFile?: string, error?: UpdateError }>} installUpdate
 * @property {() => Promise<{ version: string, stage: string, error: string, logFile: string } | null>} readInstallFailure
 *            An update that failed after the app had quit (#442, #1003), until it is cleared.
 * @property {() => Promise<void>} clearInstallFailure
 *            Forgets that failure once it has been shown (#573).
 * @property {() => Promise<boolean>} confirmInstallStarted
 *            Tells a waiting update helper that this version runs (#1003).
 */

module.exports = {};
