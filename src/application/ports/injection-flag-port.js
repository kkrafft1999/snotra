/**
 * Injection-flag port (#1011, AR-36): one tool result in, a flag or nothing out.
 *
 * A source looks at a tool result after the call ran and may say that it
 * contains text that looks like a prompt injection. That is all it can do. The
 * engine puts what the sources found on the tool row the user sees; it does
 * not change the result the model receives, and nothing that decides about a
 * tool call ever reads it (docs/quality-requirements.md §3, SEC-4: a flag
 * never loosens a boundary, and a missing flag never opens one).
 *
 * Detection is best effort. A source that throws, or answers with something
 * that is not a flag, contributes nothing — the warning fails open, the
 * boundaries do not move either way. The built-in detector
 * (`chat/injection-detector.js`) is one source; a `PostToolUse` hook (#927)
 * is meant to become another, reporting its own errors in the hook trace.
 */

/**
 * @typedef {Object} InjectionInspection
 * @property {string} toolName  as the model called it, e.g. `fetch_url` or `mcp__server__tool`
 * @property {string} category  the tool's category (#1008), `''` when unknown
 * @property {string} skill     the skill whose file the call read (#61), `''` when none
 * @property {string} content   the result as the model receives it, before it is cut to the budget
 */

/**
 * @typedef {Object} InjectionFlagPort
 * @property {(inspection: InjectionInspection)
 *   => import('../../shared/contracts/injection-flag').InjectionFlag | null
 *    | Promise<import('../../shared/contracts/injection-flag').InjectionFlag | null>} inspect
 */

module.exports = {};
