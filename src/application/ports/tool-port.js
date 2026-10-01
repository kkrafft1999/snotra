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
 * @property {string} [skillName]  the skill the path belongs to, also when given absolutely (#427)
 * @property {string} [skillPath]  the path inside that skill's folder
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
 * @property {{ command: string|null, cwd: string, networkDomains: string[], stdin: boolean }} [shellCommand]
 *   `shell_execute` only: the call in the form a remembered command is compared in (#121);
 *   `command` is null when the command line cannot be remembered
 * @property {{ disabled: boolean, root: string, allowance?: object, allowanceSkipped?: string }} [sandbox]
 *   the tools that run a process only: what the run is isolated with, as approved (#329, #357, #408)
 * @property {string} [error]  Plan nicht möglich (ungültige Argumente, Ausbruch, …)
 * @property {string} [reason]  PERMISSION_DENIAL_REASONS-Wert zu `error`
 */

/**
 * @typedef {Object} ToolPlanContext
 * @property {string} workspaceRoot
 * @property {Array<{name: string, dir: string}>} [skillRoots]
 * @property {string[]} [sensitivePathPatterns]  Nutzer-Muster zusätzlich zu den Standardmustern
 * @property {string[]} [forcedClasses]  Klassen, die eine Neubewertung erzwingt (z. B. 'delete')
 * @property {string} [locale]  interface language for the words inside the preview (#555)
 */

/**
 * @typedef {Object} ToolExecutionContext
 * @property {string} workspaceRoot
 * @property {Array<{name: string, dir: string}>} [skillRoots]
 * @property {string[]} [sensitivePathPatterns]  the user's patterns; the broad tools leave out
 *   hits under them as under the built-in ones (#525)
 * @property {AbortSignal} abortSignal
 * @property {string[]} [disabledNames] — in den Einstellungen abgewählte Tools
 * @property {boolean} approved — Policy hat den Aufruf freigegeben (Pflicht)
 * @property {ToolPlan} [plan] — der geprüfte Plan; Versionen werden vor Ausführung erneut verglichen
 * @property {string[]} [riskClasses]
 * @property {string} [locale]  the interface language, for sentences that quote a settings page (#294)
 * @property {boolean} [ownSecretsCheck]  hold the output back when it contains an own secret (§5)
 */

/**
 * Options for the tool list and the prompt built from it.
 * @typedef {Object} ToolListOptions
 * @property {string[]} [disabledNames]
 * @property {boolean} [workspaceOpen]
 * @property {string[]} [skillNames]  the switched-on skills: `load_skill` lists them, and the
 *   read tools stay without a folder while there is one (#173, #429, #548)
 */

/**
 * @typedef {Object} ToolTraceEntry
 * @property {string} tool
 * @property {object} args
 * @property {number} [waitMs]
 * @property {boolean} [noWorkspace]
 * @property {string} [line] — fertige Anzeige-Zeile (done-Phase), für Persistenz
 * @property {object} [permission] — bereinigter Audit-Eintrag (Entscheidung, Klassen, Status)
 * @property {number} [round] — 1-based tool round of the turn the call came in (#187)
 * @property {SchemaViolations} [schema] — schema violations in the arguments (#187)
 */

/**
 * Argument paths per kind of violation, never the values (#187).
 * @typedef {Object} SchemaViolations
 * @property {string[]} [unknownProperties] — e.g. `path`, `edits[0].old_text`
 * @property {string[]} [nonInteger] — a number where the schema asks for an integer
 * @property {string[]} [invalidItems] — array elements that do not match `items`
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
 * @property {(options?: ToolListOptions) => Promise<void>} [prepare] — optional: Tools auffrischen, die
 *   erst zur Laufzeit feststehen (Issue #107: die der MCP-Server). Wird einmal
 *   je Lauf aufgerufen, bevor Systemprompt und Tool-Liste gebaut werden. Darf
 *   nicht werfen — ein nicht erreichbarer Server ist kein Grund, den Chat zu
 *   beenden
 * @property {(options?: ToolListOptions) => Array} getTools
 * @property {(options?: ToolListOptions) => string} buildSystemPrompt
 * @property {(name: string) => boolean} [requiresWorkspace] — Tool braucht einen geoeffneten Ordner (Issue #96)
 * @property {(name: string) => boolean} [supportsSkillPaths] — takes `skill:` paths, and so works without a folder while a skill is on (#429)
 * @property {(name: string, disabledNames: string[]) => boolean} [isSwitchedOff] — whether the user's
 *   switch-off applies to this tool; never to the basic equipment (#552). Without it, the name list decides
 *   on its own
 * @property {(toolName: string, args: object, extra?: object) => ToolTraceEntry} buildTraceEntry
 * @property {(name: string, args: object) => (SchemaViolations|null)} [measureArguments] — optional:
 *   schema violations the planner lets through (#187); a measurement, never a refusal
 * @property {(entry: ToolTraceEntry, phase: string, locale?: string) => string} formatDisplayLine
 * @property {(name: string, args: object, ctx: ToolPlanContext) => Promise<ToolPlan>} plan
 * @property {(name: string, args: object, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>} execute
 */

module.exports = {};
