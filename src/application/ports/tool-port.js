/**
 * Tool-Port: Workspace-Tools ohne konkrete Registry im Core.
 *
 * Seit Issue #66 plant der Adapter jeden Aufruf vor der Ausführung: er
 * ermittelt Wirkung (Risikoklassen), alle Zielpfade, Dateiversionen und
 * Sensitivität. Die Engine entscheidet damit über Freigabe oder Ablehnung
 * und ruft `execute` nur mit `approved: true` und dem geprüften Plan auf.
 */

/**
 * @typedef {Object} ToolPlanTarget
 * @property {string} path  logischer Pfad wie vom Modell übergeben (ggf. `skill:…`)
 * @property {'file'|'directory'|'tree'} kind
 * @property {boolean} exists
 * @property {string|null} version  Dateiversion (Größe+Änderungszeit) oder null
 * @property {boolean} sensitive
 * @property {string} [sensitiveReason]
 * @property {string} [recovery]  z. B. 'trash', wenn eine Wiederherstellungskopie angelegt wird
 */

/**
 * @typedef {Object} ToolPlan
 * @property {string} tool
 * @property {string[]} riskClasses  effektive Klassen (Mindestklasse + dynamische Merkmale)
 * @property {ToolPlanTarget[]} targets
 * @property {string} planKey  stabiler Schlüssel aus Tool, Argumenten, Zielen und Versionen
 * @property {string} [recovery]
 * @property {{ kind: string, text: string, truncated: boolean, masked: boolean }} [preview]
 * @property {{ reason: string }} [hardLimit]  verletzte harte Grenze → deny in jedem Modus
 * @property {boolean} [unknownTool]
 * @property {string} [error]  Plan nicht möglich (ungültige Argumente, Ausbruch, …)
 * @property {string} [reason]  PERMISSION_DENIAL_REASONS-Wert zu `error`
 */

/**
 * @typedef {Object} ToolPlanContext
 * @property {string} workspaceRoot
 * @property {Array<{name: string, dir: string}>} [skillRoots]
 * @property {string[]} [sensitivePathPatterns]  Nutzer-Muster zusätzlich zu den Standardmustern
 * @property {string[]} [forcedClasses]  Klassen, die eine Neubewertung erzwingt (z. B. 'delete')
 */

/**
 * @typedef {Object} ToolExecutionContext
 * @property {string} workspaceRoot
 * @property {AbortSignal} abortSignal
 * @property {string[]} [disabledNames] — in den Einstellungen abgewählte Tools
 * @property {boolean} approved — Policy hat den Aufruf freigegeben (Pflicht)
 * @property {ToolPlan} [plan] — der geprüfte Plan; Versionen werden vor Ausführung erneut verglichen
 * @property {string[]} [riskClasses]
 */

/**
 * @typedef {Object} ToolTraceEntry
 * @property {string} tool
 * @property {object} args
 * @property {number} [waitMs]
 * @property {boolean} [noWorkspace]
 * @property {string} [line] — fertige Anzeige-Zeile (done-Phase), für Persistenz
 * @property {object} [permission] — bereinigter Audit-Eintrag (Entscheidung, Klassen, Status)
 */

/**
 * @typedef {Object} ToolExecutionResult
 * @property {string} output — JSON-String für die Tool-Nachricht ans Modell
 * @property {Array<object>} [progressEvents] — fertige chat:progress-Payloads vom Adapter
 * @property {boolean} [invalidated] — Ziel hat sich seit dem Plan geändert; nicht ausgeführt
 * @property {string[]} [reclassify] — Aufruf hat sich als riskanter erwiesen (z. B. 'delete'); nicht ausgeführt
 * @property {boolean} [sensitive] — Ausgabe enthält lokal erkannte sensible Inhalte
 * @property {{ reason: string }} [hardLimit] — Ausgabe zurückgehalten (z. B. eigene Provider-Secrets)
 */

/**
 * @typedef {Object} ToolPort
 * @property {(options?: { disabledNames?: string[] }) => Array} getTools
 * @property {(options?: { disabledNames?: string[] }) => string} buildSystemPrompt
 * @property {(toolName: string, args: object, extra?: object) => ToolTraceEntry} buildTraceEntry
 * @property {(entry: ToolTraceEntry, phase: string, locale?: string) => string} formatDisplayLine
 * @property {(name: string, args: object, ctx: ToolPlanContext) => Promise<ToolPlan>} plan
 * @property {(name: string, args: object, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>} execute
 */

module.exports = {};
