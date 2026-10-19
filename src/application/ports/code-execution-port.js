/**
 * Code-Ausfuehrungs-Port (Issue #86).
 *
 * Ausgefuehrter Code ist qualitativ etwas anderes als die Datei-Tools: er
 * umgeht die Workspace-Grenze grundsaetzlich, weil nicht Snotra die
 * Dateizugriffe macht, sondern der Interpreter. Der Port bleibt deshalb
 * bewusst eng — ein Programm rein, Ausgabe und Exit-Code raus, kein Zustand
 * zwischen zwei Aufrufen.
 *
 * @typedef {Object} CodeExecutionResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number|null} exitCode  null, wenn der Prozess per Signal endete
 * @property {boolean} timedOut
 * @property {boolean} aborted       durch „Stop" im Chat beendet
 * @property {boolean} truncated     Ausgabe wurde gekappt
 * @property {number} durationMs
 * @property {{isolated: boolean, domains?: string[], reason?: string, missing?: string[]}} [isolation]
 *   whether the run was isolated (#329); absent when no sandbox is wired
 * @property {Object} [sandboxBlocked]  what the sandbox refused (#792), for the chat's tool row
 *
 * @typedef {Object} CodeExecutionRefusal  a run that never started
 * @property {string} error   an English sentence for the model
 *
 * @typedef {Object} CodeExecutionRequest
 * @property {string} code
 * @property {string} [stdin]
 * @property {string[]} [argv]
 * @property {number} [timeoutMs]
 * @property {string} [cwd]
 * @property {string} [workspaceRoot]
 * @property {string[]} [networkDomains]
 * @property {Object|null} [sandboxGrants]  what the user allowed on a sandbox card (#792)
 * @property {((request: { target: string, allow: string[] }, options?: { signal?: AbortSignal }) => Promise<{ outcome: string, pattern?: string }>)|null} [onSandboxNetworkAsk]  asks about a connection while the script waits (#792)
 * @property {boolean} [sandboxDisabled]  the sandbox is switched off for this workspace (#357)
 * @property {AbortSignal} [abortSignal]
 *
 * @typedef {Object} CodeDescription
 * @property {boolean} found
 * @property {string} [command]   the interpreter
 * @property {string[]} [args]    its fixed arguments (`py -3`)
 * @property {string} [version]
 * @property {'override'|'auto'} [source]  a path from the settings, or found on its own
 * @property {'login-shell'|'inherited'} [pathSource]  where PATH came from (#111)
 * @property {string|import('../../shared/contracts/message').Message} [error]  a catalogue
 *   message, or the quoted output of the probe (#338); shown in Settings, never to the model
 *
 * @typedef {Object} CodeExecutionPort
 * @property {() => boolean} isAvailable
 *   Ob ein Interpreter gefunden wurde. Synchron, weil die Tool-Sichtbarkeit
 *   beim Bauen der Tool-Liste feststehen muss.
 * @property {() => CodeDescription} describe
 * @property {(request: CodeExecutionRequest) => Promise<CodeExecutionResult | CodeExecutionRefusal>} run
 */

module.exports = {};
