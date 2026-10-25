/**
 * Shell-Ausfuehrungs-Port (Issue #102).
 *
 * Neben dem `code-execution-port` die zweite Ausfuehrungsfaehigkeit — und die
 * weitreichendere.
 *
 * Since #329 a run is isolated on macOS and Linux: it writes only inside the
 * workspace and its own temp directory, cannot read credential stores, and
 * reaches the network only for the approved domains. On Windows, or where the
 * sandbox is unavailable, a command can do everything the logged-in user can;
 * there the protection is the visible command plus an approval before every
 * single run (concept §9). Pattern lists are a second line, not a promise.
 *
 * Wie beim Code-Port bleibt die Oberflaeche eng: ein Befehl rein, Ausgabe und
 * Exit-Code raus, kein Zustand zwischen zwei Aufrufen. Kein dauerhafter
 * Shell-Prozess, kein `cd`, das den naechsten Aufruf beeinflusst.
 *
 * @typedef {Object} ShellExecutionResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number|null} exitCode  null, wenn der Prozess per Signal endete
 * @property {boolean} timedOut
 * @property {boolean} aborted       durch „Stop" im Chat beendet
 * @property {boolean} truncated     Ausgabe wurde gekappt
 * @property {number} durationMs
 * @property {string} shell          Anzeigename der tatsaechlich benutzten Shell
 * @property {{isolated: boolean, domains?: string[], reason?: string, missing?: string[]}} [isolation]
 *   whether the run was isolated (#329); absent when no sandbox is wired
 * @property {Object} [sandboxBlocked]  what the sandbox refused (#792), for the chat's tool row
 * @property {{set: string[], unavailable: string[]}} [credentials]  the variables of a program
 *   allowance the run got, and those whose value could not be read (#1262) — names only
 *
 * @typedef {Object} ShellExecutionRefusal  a run that never started
 * @property {string} error   an English sentence for the model
 * @property {boolean} [blocked]  refused by the command guard (concept §9)
 *
 * @typedef {Object} ShellExecutionRequest
 * @property {string} command
 * @property {string} [stdin]
 * @property {number} [timeoutMs]
 * @property {string} [cwd]
 * @property {string} [workspaceRoot]
 * @property {string[]} [networkDomains]
 * @property {{writePaths?: string[], trustd?: boolean, path?: string, root?: string|null,
 *   credentials?: Array<{name: string, id: string}>}|null} [programAllowance]  a program
 *   allowance's folders and trustd (#408); its domains are part of `networkDomains`. Its
 *   credentials (#1262) come as names and ids — the runner reads the values itself, for
 *   the allowance of `path` in workspace `root`, and masks them in what it returns.
 * @property {Object|null} [sandboxGrants]  what the user allowed on a sandbox card (#792)
 * @property {((request: { target: string, allow: string[] }, options?: { signal?: AbortSignal }) => Promise<{ outcome: string, pattern?: string }>)|null} [onSandboxNetworkAsk]  asks about a connection while the command waits (#792)
 * @property {boolean} [sandboxDisabled]  the sandbox is switched off for this workspace (#357)
 * @property {AbortSignal} [abortSignal]
 *
 * @typedef {Object} ShellDescription
 * @property {boolean} found
 * @property {string} [command]      Programmpfad der Shell
 * @property {string} [label]        Anzeigename („zsh", „PowerShell 7")
 * @property {string} [invocation]   Aufrufform fuer Befehle (siehe shell-runner-service)
 * @property {boolean} [login]       POSIX-Shell als Login-Shell gestartet (PATH aus dem Profil)
 * @property {string} [probeInvocation] Aufrufform der Erkennung (Issue #111)
 * @property {boolean} [interactive] Erkennung lief interaktiv, `.zshrc` war also dabei
 * @property {string} [path]         PATH aus dem Profil, einmal beim Start gelesen (#111)
 * @property {string|import('../../shared/contracts/message').Message} [error]  a catalogue
 *   message, or the quoted output of the probe (#338); shown in Settings, never to the model
 *
 * @typedef {Object} ShellExecutionPort
 * @property {() => boolean} isAvailable
 *   Ob eine Shell gefunden und die Ausfuehrung eingeschaltet ist. Synchron,
 *   weil die Tool-Sichtbarkeit beim Bauen der Tool-Liste feststehen muss.
 * @property {() => ShellDescription} describe
 * @property {(request: ShellExecutionRequest) => Promise<ShellExecutionResult | ShellExecutionRefusal>} run
 */

module.exports = {};
