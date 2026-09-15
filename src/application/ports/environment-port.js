/**
 * Environment-Port: die Umgebungsangaben, die der Chat-Core fuer den
 * Environment-Block im Systemprompt braucht (Issue #138).
 *
 * Der Core darf nichts davon selbst ermitteln — `process.platform`,
 * `os.release()` und der Blick auf `.git` sind Laufzeitwissen und gehoeren
 * deshalb hinter diesen Port.
 */

/**
 * @typedef {Object} EnvironmentFacts
 * @property {string} [appName] — Name der App, z. B. „Snotra AI"
 * @property {string} [appVersion] — Version der App, z. B. „1.5.0"
 * @property {string|null} [workspaceRoot] — absoluter Pfad des offenen Ordners
 * @property {boolean|null} [isGitRepository] — `null`, wenn nicht ermittelbar
 * @property {string} [platform] — `process.platform`: darwin | win32 | linux
 * @property {string} [osVersion] — lesbare Systemversion, z. B. „Darwin 27.0.0"
 * @property {string|null} [shell] — Shell, in der `shell_execute` laeuft;
 *   `null`, wenn das Tool aus oder keine Shell gefunden ist
 * @property {Date} [now] — lokale Zeit fuer die Datumsangabe
 */

/**
 * @typedef {Object} EnvironmentPort
 * @property {(options: { workspaceRoot?: string|null }) => Promise<EnvironmentFacts>} describe
 */

module.exports = {};
