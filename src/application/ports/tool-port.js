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
 * @property {string|null} [skillName]  the skill the path belongs to, also when given absolutely (#427)
 * @property {string} [skillPath]  the path inside that skill's folder
 * @property {import('../../shared/contracts/knowledge-files').KnowledgeFileKind} [knowledge]  a knowledge file of the open folder is written (#1319)
 * @property {boolean} [knowledgeAlways]  the rules file written says `always: true` (#1319)
 * @property {string} [absPath]  the resolved absolute path
 * @property {string|null} [root]  the folder the path resolved in: the open folder or a skill's; `null` for a target outside both
 * @property {string[]} [rulePaths]  the spellings a permission rule is matched against, lexical and real
 * @property {'read'|'write'} [access]  what the call does with a path outside the open folder (#792)
 * @property {{ offers: OutsideGrant[] }} [outside]  a path outside the open folder no card has opened
 *   yet, and what a card may open for it (#792, step 4)
 * @property {boolean} [outsideGranted]  a path outside the open folder a card has opened
 */

/**
 * Something outside the open folder a card opened, or may open, for the file
 * tools (#792, step 4).
 * @typedef {Object} OutsideGrant
 * @property {string} path
 * @property {boolean} [file]  a single file rather than a folder
 * @property {'read'|'write'} [access]
 */

/**
 * @typedef {Object} ToolPlan
 * @property {string} tool
 * @property {string[]} riskClasses  effektive Klassen (Mindestklasse + dynamische Merkmale)
 * @property {ToolPlanTarget[]} targets
 * @property {string} [planKey]  stabiler Schlüssel aus Tool, Argumenten, Zielen und Versionen;
 *   absent on a plan that failed (`error`)
 * @property {string} [recovery]
 * @property {{ kind: string, text: string, truncated: boolean, masked: boolean,
 *   isolation?: object, shell?: string, shellLogin?: boolean, cwd?: string, memoryScope?: string,
 *   stdin?: string, argv?: string[] }} [preview]
 * @property {{ category: string, verb?: string, warning?: string }} [presentation]  how the approval
 *   card speaks of the tool, from its descriptor (#1008)
 * @property {{ reason: string }} [hardLimit]  verletzte harte Grenze → deny in jedem Modus
 * @property {boolean} [unknownTool]
 * @property {{ command: string|null, cwd: string, networkDomains: string[], stdin: boolean }} [shellCommand]
 *   shell commands only: the call in the form a remembered command is compared in (#121);
 *   `command` is null when the command line cannot be remembered
 * @property {{ disabled: boolean, root: string,
 *   allowance?: { program: string, command: string, writePaths?: string[], trustd?: boolean, [field: string]: any },
 *   allowanceSkipped?: { program: string, reason: string } }} [sandbox]
 *   the tools that run a process only: what the run is isolated with, as approved (#329, #357, #408)
 * @property {string} [error]  Plan nicht möglich (ungültige Argumente, Ausbruch, …)
 * @property {string} [reason]  PERMISSION_DENIAL_REASONS-Wert zu `error`
 * @property {boolean} [outside]  a target lies outside the open folder and no card has opened it (#792)
 * @property {boolean} [knowledge]  a target is a knowledge file: a card in every mode, no stored allowance (#1319)
 * @property {string[]} [sensitivePathPatterns]  the user's patterns the plan was made with
 */

/**
 * @typedef {Object} ToolPlanContext
 * @property {string|null} workspaceRoot  null while no folder is open
 * @property {Array<{name: string, dir: string}>} [skillRoots]
 * @property {string[]} [sensitivePathPatterns]  Nutzer-Muster zusätzlich zu den Standardmustern
 * @property {string[]} [forcedClasses]  Klassen, die eine Neubewertung erzwingt (z. B. 'delete')
 * @property {string} [locale]  interface language for the words inside the preview (#555)
 * @property {OutsideGrant[]} [outsideGrants]  what cards opened outside the open folder (#792, step 4)
 */

/**
 * @typedef {Object} ToolExecutionContext
 * @property {string|null} workspaceRoot  null while no folder is open
 * @property {Array<{name: string, dir: string}>} [skillRoots]
 * @property {Array<{name: string, level: string}>} [ruleNames]  what `load_rule` may load (#1275)
 * @property {string[]} [sensitivePathPatterns]  the user's patterns; the broad tools leave out
 *   hits under them as under the built-in ones (#525)
 * @property {AbortSignal} abortSignal
 * @property {string[]} [disabledNames]  in den Einstellungen abgewählte Tools
 * @property {string[]} [revealedNames]  MCP tools whose schema the run loaded with `load_tools` (#188)
 * @property {boolean} approved — Policy hat den Aufruf freigegeben (Pflicht)
 * @property {ToolPlan} [plan]  der geprüfte Plan; Versionen werden vor Ausführung erneut verglichen
 * @property {string[]} [riskClasses]
 * @property {string} [locale]  the interface language, for sentences that quote a settings page (#294)
 * @property {boolean} [ownSecretsCheck]  hold the output back when it contains an own secret (§5)
 * @property {{ writePaths: string[], readPaths: string[], hosts: string[] }|null} [sandboxGrants]
 *   what sandbox cards opened for the shell and Python runs of this chat (#792)
 * @property {(request: { target: string, allow: string[] }, options?: { signal?: AbortSignal })
 *   => Promise<{ outcome: string, pattern?: string }>} [onSandboxNetworkAsk]
 *   asks about a connection the sandbox holds while the command waits (#792); never throws
 * @property {OutsideGrant[]} [outsideGrants]  what cards opened outside the open folder (#792, step 4)
 * @property {import('../../shared/contracts/chat-configuration').ChatConfigOverrides|null} [configOverrides]
 *   what this chat switched on a card, for `get_configuration` (#774)
 */

/**
 * What a tool handler gets next to its arguments: the call's context and what
 * the adapter adds before it hands the call over (#1098). All of it is
 * optional — a handler called directly, by a test or a stub, gets less.
 *
 * @typedef {Partial<ToolExecutionContext> & {
 *   outsideRoots?: Array<{ root: string, only: string|null, access: 'read'|'write' }>,
 *   sensitivity?: { isSensitivePath: (relPath: string) => boolean, isSensitiveLine: (text: string) => boolean },
 *   recovery?: { trashItem: ((absPath: string) => Promise<void>) | null, allowUnrecoverable: boolean },
 *   onWritten?: (written: object) => void,
 *   onSandboxBlocked?: (summary: object | null) => void,
 * }} ToolHandlerContext
 */

/**
 * A call's arguments as the model sent them: parsed JSON, checked by the
 * planner, never trusted before that.
 * @typedef {Object<string, any>} ToolArguments
 */

/**
 * Options for the tool list and the prompt built from it.
 * @typedef {Object} ToolListOptions
 * @property {string[]} [disabledNames]
 * @property {boolean} [workspaceOpen]
 * @property {string[]} [skillNames]  the switched-on skills: `load_skill` lists them, and the
 *   read tools stay without a folder while there is one (#173, #429, #548)
 * @property {string[]} [revealedNames]  MCP tools whose schema the run loaded with `load_tools` (#188)
 * @property {Array<{name: string, level: string}>} [ruleNames]  the rules of this request: `load_rule`
 *   lists them, and without any it is not offered (#1275)
 */

/**
 * @typedef {Object} ToolTraceEntry
 * @property {string} tool
 * @property {ToolArguments} args
 * @property {number} [waitMs]
 * @property {boolean} [noWorkspace]
 * @property {string} [line]  fertige Anzeige-Zeile (done-Phase), für Persistenz
 * @property {import('../../shared/contracts/tool-permissions').PermissionAuditEntry & { sensitive?: true }} [permission]
 *   bereinigter Audit-Eintrag (Entscheidung, Klassen, Status); `sensitive` when the output was bound to a provider
 * @property {number} [round]  1-based tool round of the turn the call came in (#187)
 * @property {SchemaViolations} [schema]  schema violations in the arguments (#187)
 * @property {string} [skill]  the skill the call reads from or writes to (#61, #160, #173)
 * @property {string} [category]  icon and group in the tool log, from the descriptor (#1008)
 * @property {Array<object>} [changes]  what the call changed, summaries only (#348)
 * @property {import('../../shared/contracts/chat').SandboxBlocked|null} [sandboxBlocked]  what the sandbox refused during the run (#792);
 *   `null` while a refusal waits to be normalized
 * @property {import('../../shared/contracts/chat').SandboxDecision} [sandboxDecision]  what the user decided on the sandbox card (#792)
 * @property {import('../../shared/contracts/chat').SandboxLiveEntry[]|null} [sandboxLive]  connections decided while the command waited (#792)
 * @property {import('../../shared/contracts/chat').SandboxOutsideEntry[]|null} [sandboxOutside]  paths outside the open folder decided on a card (#792)
 * @property {{ originalChars: number, keptChars: number }} [shortened]  output cut to the budget (#169)
 * @property {{ files: Array<{ path: string, status: string }>, kept: boolean }} [knowledgeChange]  what a command changed in
 *   the folder's knowledge files, and whether the user kept it (#1319)
 * @property {import('../../shared/contracts/injection-flag').InjectionFlag} [injectionFlag]  the result looks like
 *   a prompt injection (#1011) — a warning for the user, read by nothing that decides
 * @property {string} [skillPath]  a skill file reached by its absolute path, in the skill's own spelling (#427)
 * @property {{ outcome?: string }} [configProposal]  how a `propose_config` call ended (#774)
 */

/**
 * Argument paths per kind of violation, never the values (#187).
 * @typedef {Object} SchemaViolations
 * @property {string[]} [unknownProperties]  e.g. `path`, `edits[0].old_text`
 * @property {string[]} [nonInteger]  a number where the schema asks for an integer
 * @property {string[]} [invalidItems]  array elements that do not match `items`
 */

/**
 * @typedef {Object} ToolExecutionResult
 * @property {string} output — JSON-String für die Tool-Nachricht ans Modell
 * @property {Array<object>} [progressEvents]  fertige chat:progress-Payloads vom Adapter
 * @property {boolean} [invalidated]  Ziel hat sich seit dem Plan geändert; nicht ausgeführt
 * @property {string[]} [reclassify]  Aufruf hat sich als riskanter erwiesen (z. B. 'delete'); nicht ausgeführt
 * @property {boolean} [sensitive]  Ausgabe enthält lokal erkannte sensible Inhalte
 * @property {{ reason: string }} [hardLimit]  Ausgabe zurückgehalten (z. B. eigene Provider-Secrets)
 * @property {Array<object>} [fileChanges]  what a writing tool changed, before and after (#348)
 * @property {SandboxRefusal} [sandboxBlocked]  what the sandbox refused during a shell or Python run (#792)
 */

/**
 * What the sandbox refused during one run, as the runner reports it. The engine
 * normalizes it (`normalizeSandboxBlocked`) before it travels to the renderer
 * or is stored. `allow` lists what a card may open for the entry.
 *
 * @typedef {Object} SandboxRefusal
 * @property {Array<{ kind: string, target: string, count: number, folder?: boolean, allow?: string[] }>} [entries]
 * @property {string[]} [raw]
 */

/**
 * @typedef {Object} ToolPort
 * @property {(options?: ToolListOptions) => Promise<void>} [prepare]  optional: Tools auffrischen, die
 *   erst zur Laufzeit feststehen (Issue #107: die der MCP-Server). Wird einmal
 *   je Lauf aufgerufen, bevor Systemprompt und Tool-Liste gebaut werden. Darf
 *   nicht werfen — ein nicht erreichbarer Server ist kein Grund, den Chat zu
 *   beenden
 * @property {(options?: ToolListOptions) => Array<object>} getTools
 * @property {(options?: ToolListOptions) => string} buildSystemPrompt
 * @property {(name: string) => boolean} [requiresWorkspace]  Tool braucht einen geoeffneten Ordner (Issue #96)
 * @property {(name: string) => boolean} [supportsSkillPaths]  takes `skill:` paths, and so works without a folder while a skill is on (#429)
 * @property {(name: string, disabledNames: string[]) => boolean} [isSwitchedOff]  whether the user's
 *   switch-off applies to this tool; never to the basic equipment (#552). Without it, the name list decides
 *   on its own
 * @property {(options?: ToolListOptions) => string[]} [listDeferredTools]  MCP tools the prompt only
 *   lists by name and whose schema the run has not loaded (#188); calling one is refused. Without it,
 *   every tool has its schema
 * @property {(toolName: string, args: ToolArguments, extra?: object) => ToolTraceEntry} buildTraceEntry
 * @property {(name: string, args: ToolArguments) => (SchemaViolations|null)} [measureArguments]  optional:
 *   schema violations the planner lets through (#187); a measurement, never a refusal
 * @property {(entry: ToolTraceEntry, phase: string, locale?: string) => string} formatDisplayLine
 * @property {(name: string, args: ToolArguments, ctx: ToolPlanContext) => Promise<ToolPlan>} plan
 * @property {(name: string, args: ToolArguments, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>} execute
 */

module.exports = {};
