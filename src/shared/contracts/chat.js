/**
 * Chat-DTO- und Event-Contract (Roadmap-Etappe 1).
 *
 * Factories für die Ergebnis-Objekte von CHAT_SEND und für die Push-Events
 * (chat:delta, chat:tool-line, chat:progress). Sie erzeugen exakt die Formen,
 * die vom Chat-Core erzeugt und vom IPC-Adapter an den Renderer weitergeleitet
 * werden — so bleibt das Wire-Format stabil, während Erzeugung und Validierung
 * zentral liegen.
 */
'use strict';

const { countImageAttachments } = require('./attachments');
const { createMessage } = require('./message');
const { isRecord } = require('../runtime/is-record');
const {
  CHAT_ERROR_CODES,
  CHAT_PHASES,
  TOOL_LINE_PHASES,
  CHAT_PROGRESS_TYPES,
  WORKSPACE_PROGRESS_EVENTS,
} = require('./enums');

// --- Konversationstitel -----------------------------------------------------

/** Maximale Laenge eines abgeleiteten Titels (inkl. Auslassungszeichen). */
const CHAT_TITLE_MAX_LENGTH = 48;

/** The longest chat id a run is keyed by. */
const CHAT_ID_MAX_LENGTH = 128;

/**
 * How a chat became the active one (#211). `auto` = without the user doing
 * anything (start, folder switch); only `explicit` brings a stored "Auto"
 * back, and anything that is not exactly `explicit` counts as `auto` (#567).
 */
const CHAT_ACTIVATION = Object.freeze({
  EXPLICIT: 'explicit',
  AUTO: 'auto',
});

/**
 * A chat id as main and the engine both take it (#532): a trimmed, non-empty
 * string of at most 128 characters, otherwise `null` — never cut down, since
 * two ids sharing a prefix would then share one run.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function sanitizeChatId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > CHAT_ID_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Shortens a title by characters, not by UTF-16 units: a cut through an emoji
 * would leave half a surrogate pair, drawn as "�" (#532).
 *
 * @param {string} text
 */
function clipChatTitle(text) {
  const chars = Array.from(text);
  if (chars.length <= CHAT_TITLE_MAX_LENGTH) return text;
  return `${chars.slice(0, CHAT_TITLE_MAX_LENGTH - 1).join('')}…`;
}

/**
 * The short title a conversation gets from its first user message. The history
 * store (main) and the chat header (renderer) both use it — they have to show
 * the same text, which is why the rule lives here.
 *
 * With text there is something to shorten, and the user's own words need no
 * translation. Without it, the title names what the message holds — a
 * screenshot on its own is a valid first message (#94) — and that name belongs
 * to the interface language. The contract cannot know that language, so it
 * answers with a message descriptor and the side that shows it looks it up
 * (`translateMessage`, `tMessage`; #359).
 *
 * @param {unknown} messages
 * @returns {string|Message}
 */
function inferChatTitle(messages) {
  const text = inferChatTitleText(messages);
  if (text) return text;
  const list = Array.isArray(messages) ? messages : [];
  const first = list.find((m) => m && m.role === 'user');
  const images = first ? countImageAttachments(first) : 0;
  if (images === 1) return createMessage('chat.title.image');
  if (images > 1) return createMessage('chat.title.images', { count: images });
  return createMessage('chat.title.new');
}

/**
 * Only the part of `inferChatTitle` that comes from the user's text — an empty
 * string when the first message has none. This is what the history store
 * writes: a fallback title is not a title, it is worked out again in whatever
 * language the chat is read in.
 *
 * @param {unknown} messages
 */
function inferChatTitleText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list.find((m) => m && m.role === 'user');
  if (!first || first.content == null) return '';
  const text = String(first.content).trim().replace(/\s+/g, ' ');
  return clipChatTitle(text);
}

/**
 * Until #359 the fallback titles were stored as finished German text. Such a
 * title is only a fallback when the first message has no text — otherwise the
 * old rule would have used the text — so a chat that literally opened with
 * "Bild" keeps its title.
 *
 * @param {unknown} title
 * @param {unknown} messages
 */
function isLegacyFallbackChatTitle(title, messages) {
  if (typeof title !== 'string' || inferChatTitleText(messages)) return false;
  const value = title.trim();
  return value === 'Neuer Chat' || value === 'Bild' || value === 'Chat' || /^\d+ Bilder$/.test(value);
}

/**
 * Has this chat been given a title of its own — by the model or otherwise — or
 * does it still carry the one derived from its first message? Only the second
 * kind may be replaced by a generated title.
 *
 * @param {unknown} title
 * @param {unknown} messages
 */
function isDerivedChatTitle(title, messages) {
  const value = typeof title === 'string' ? title.trim() : '';
  if (!value) return true;
  return value === inferChatTitleText(messages) || isLegacyFallbackChatTitle(value, messages);
}

/**
 * The title to show for a stored chat: its own title, or — when it has none, or
 * only a derived one — `inferChatTitle`. Like that one, the result may be a
 * message descriptor.
 *
 * @param {unknown} title
 * @param {unknown} messages
 * @returns {string|Message}
 */
function resolveChatTitle(title, messages) {
  const value = typeof title === 'string' ? title.trim() : '';
  if (value && !isLegacyFallbackChatTitle(value, messages)) return value;
  return inferChatTitle(messages);
}

/**
 * Raeumt eine Modellantwort zu einer Ueberschrift auf: erste Zeile, ohne
 * Anfuehrungszeichen, ohne Schlusspunkt, auf eine Zeile normalisiert und auf
 * CHAT_TITLE_MAX_LENGTH gekuerzt. Leerer String, wenn nichts uebrig bleibt —
 * dann bleibt der Aufrufer beim abgeleiteten Titel.
 *
 * @param {unknown} raw
 */
function sanitizeChatTitle(raw) {
  if (raw == null) return '';
  let text = String(raw).split('\n').find((line) => line.trim()) || '';
  text = text.trim().replace(/\s+/g, ' ');
  // Manche Modelle verpacken die Ueberschrift in Anfuehrungszeichen, stellen
  // ein „Titel:“ voran — oder beides, in beliebiger Schachtelung. Deshalb
  // zweimal abtragen: aussen die Zeichen, dann der Vorsatz, dann erneut.
  const unquote = (/** @type {string} */ value) => value.replace(/^["'«»„“”‚‘’]+/, '').replace(/["'«»„“”‚‘’]+$/, '').trim();
  text = unquote(text);
  text = text.replace(/^(?:titel|title|ueberschrift|überschrift)\s*:\s*/i, '').trim();
  text = unquote(text);
  text = text.replace(/[.]+$/, '').trim();
  if (!text) return '';
  return clipChatTitle(text);
}

// --- Ergebnis-DTOs (Rückgabe von CHAT_SEND) --------------------------------

/*
 * Zwei Usage-Felder mit unterschiedlicher Bedeutung:
 *   usage         Summe ueber alle LLM-Runden dieses Zugs (Verbrauch).
 *   contextUsage  Usage der letzten LLM-Runde. Deren `prompt` ist die Groesse
 *                 des Kontextfensters, das zuletzt tatsaechlich an das Modell
 *                 ging — das zeigt der Token-Zaehler im Composer.
 *   contextBreakdown  Woraus dieses Kontextfenster besteht (Issue #174):
 *                 geschaetzte Anteile je Skill, Tool-Gruppe und Verlauf.
 * Beide werden nur aufgenommen, wenn sie uebergeben wurden, damit die
 * bestehenden Wire-Formen unveraendert bleiben.
 */

/**
 * @typedef {import('./message').Message} Message
 */

/**
 * The recorder's summary of one write, without content (#348).
 *
 * @typedef {Object} FileChangeSummary
 * @property {string} id
 * @property {string} relativePath
 * @property {string} status  `text`, `unchanged`, `eol-only`, `binary` or `too-large`
 * @property {boolean} created
 * @property {number} added
 * @property {number} removed
 */

/**
 * What the sandbox refused during one run, as it is shown and stored (#792).
 *
 * @typedef {Object} SandboxBlockedEntry
 * @property {string} kind  one of SANDBOX_BLOCKED_KINDS
 * @property {string} target
 * @property {number} count
 * @property {true} [folder]
 * @property {string[]} [operations]
 * @property {string} [reason]
 *
 * @typedef {Object} SandboxBlocked
 * @property {SandboxBlockedEntry[]} entries
 * @property {number} moreEntries
 * @property {number} total
 * @property {string[]} raw
 */

/**
 * What the user decided on a sandbox card (#792).
 *
 * @typedef {Object} SandboxDecision
 * @property {string} outcome  `allowed`, `denied` or `unanswered`
 * @property {'run'|'session'|'workspace'} [duration]  allowed only
 * @property {Array<{ kind: string, path: string }>} [paths]  allowed only
 * @property {{ exitCode: number|null, blocked?: SandboxBlocked }} [retry]  allowed only
 */

/**
 * A connection decided while a command waited (#792).
 *
 * @typedef {Object} SandboxLiveEntry
 * @property {string} target
 * @property {'allowed'|'denied'} outcome
 * @property {'run'|'session'|'workspace'} [duration]  allowed only
 * @property {string} [pattern]  allowed only
 */

/**
 * A path outside the open folder decided on a card (#792, step 4).
 *
 * @typedef {Object} SandboxOutsideEntry
 * @property {'read'|'write'} kind
 * @property {string} target
 * @property {'allowed'|'denied'} outcome
 * @property {'session'|'call'} [duration]  allowed only
 * @property {string} [pattern]  allowed only
 * @property {true} [folder]
 * @property {true} [sensitive]
 */

/**
 * The fields every result of a turn may carry.
 *
 * @typedef {Object} ChatResultParts
 * @property {Array<object>} [toolTrace]  the tool steps of the turn
 * @property {object|null} [usage]        summed over every round of the turn
 * @property {object|null} [contextUsage] the last round's usage
 * @property {object|null} [contextBreakdown]  what the last context window was made of (#174)
 */

/**
 * @typedef {ChatResultParts & { content: string, toolTrace: Array<object>, usage: object|null }} ChatResult
 * @typedef {ChatResult & { cancelled: true }} ChatCancelledResult
 * @typedef {ChatResultParts & { error: Message|string, code: string, partial?: true }} ChatErrorResult
 */

/**
 * Erfolgreiches Chat-Ergebnis (Modell hat geantwortet, keine Tools mehr offen).
 *
 * @param {ChatResultParts & { content?: string }} [parts]
 * @returns {ChatResult}
 */
function createChatResult({
  content = '',
  toolTrace = [],
  usage = null,
  contextUsage,
  contextBreakdown,
} = {}) {
  /** @type {ChatResult} */
  const result = { content, toolTrace, usage };
  if (contextUsage !== undefined) result.contextUsage = contextUsage;
  if (contextBreakdown !== undefined) result.contextBreakdown = contextBreakdown;
  return result;
}

/**
 * Vom Nutzer bzw. per AbortSignal abgebrochenes Chat-Ergebnis.
 *
 * @param {ChatResultParts & { content?: string }} [parts]
 * @returns {ChatCancelledResult}
 */
function createCancelledChatResult({
  content = '',
  toolTrace = [],
  usage = null,
  contextUsage,
  contextBreakdown,
} = {}) {
  /** @type {ChatCancelledResult} */
  const result = { cancelled: true, content, toolTrace, usage };
  if (contextUsage !== undefined) result.contextUsage = contextUsage;
  if (contextBreakdown !== undefined) result.contextBreakdown = contextBreakdown;
  return result;
}

/**
 * Fehler-Ergebnis. usage/contextUsage werden nur aufgenommen, wenn sie
 * übergeben wurden — Frühabbrüche (z. B. leere Nachricht) bleiben so bei der
 * schlanken Form { error, code }, wie sie der Renderer erwartet.
 *
 * @param {ChatResultParts & { error: Message|string, code?: string, partial?: boolean }} parts
 * @returns {ChatErrorResult}
 */
function createChatErrorResult({
  error,
  code = CHAT_ERROR_CODES.INVALID,
  usage,
  contextUsage,
  contextBreakdown,
  toolTrace,
  partial = false,
}) {
  /** @type {ChatErrorResult} */
  const result = { error, code };
  // The answer streamed so far stays: the round was cut off, not refused (#538).
  if (partial) result.partial = true;
  if (usage !== undefined) result.usage = usage;
  if (contextUsage !== undefined) result.contextUsage = contextUsage;
  if (contextBreakdown !== undefined) result.contextBreakdown = contextBreakdown;
  // Whenever tools ran before the error — an expired approval (#66), the
  // tool round limit, a provider error in a later round (#527): the steps
  // done until then stay visible in the history.
  if (Array.isArray(toolTrace) && toolTrace.length > 0) result.toolTrace = toolTrace;
  return result;
}

// --- Push-Events (Main -> Renderer) ----------------------------------------

/**
 * chat:delta — ein Stück Antwort-Text.
 *
 * @param {unknown} text
 */
function createDeltaEvent(text) {
  return { text: String(text ?? '') };
}

/**
 * chat:tool-line — Tool-Ereignis mit Anzeige-Zeile und optionalen Rohdaten.
 * entry = { line, tool?, args?, waitMs?, noWorkspace? }.
 * `line` ist die fertige UI-Zeile; tool/args bleiben für Debugging/Kompatibilität.
 *
 * @template {object} E
 * @param {string} phase
 * @param {E} entry
 * @returns {{ phase: string } & E}
 */
function createToolLineEvent(phase, entry) {
  return { phase, ...entry };
}

/**
 * chat:progress mit type='workspace' nach erfolgreichem Dateischreiben.
 * `change` is the recorder's summary of the write (#348), without content:
 * `{ id, relativePath, status, created, added, removed }`.
 *
 * @param {unknown} relativePath
 * @param {unknown} [change]
 */
function createWorkspaceFileWrittenEvent(relativePath, change = null) {
  /** @type {Record<string, unknown>} */
  const event = {
    type: CHAT_PROGRESS_TYPES.WORKSPACE,
    event: WORKSPACE_PROGRESS_EVENTS.FILE_WRITTEN,
    relativePath: String(relativePath ?? ''),
  };
  const summary = normalizeFileChangeSummary(change);
  if (summary) event.change = summary;
  return event;
}

const FILE_CHANGE_ID_PATTERN = /^[0-9a-f]{1,16}-\d{1,12}$/;
/** @type {Set<string>} */
const FILE_CHANGE_STATUSES = new Set(['text', 'unchanged', 'eol-only', 'binary', 'too-large']);

/**
 * A change summary as it may travel and be stored (#348), or null. Counts are
 * whole numbers; anything else is dropped rather than shown.
 *
 * @param {unknown} change
 * @returns {FileChangeSummary|null}
 */
function normalizeFileChangeSummary(change) {
  if (!isRecord(change)) return null;
  const id = typeof change.id === 'string' ? change.id : '';
  if (!FILE_CHANGE_ID_PATTERN.test(id)) return null;
  const count = (/** @type {unknown} */ value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    id,
    relativePath: typeof change.relativePath === 'string' ? change.relativePath.slice(0, 4096) : '',
    status: typeof change.status === 'string' && FILE_CHANGE_STATUSES.has(change.status) ? change.status : 'text',
    created: change.created === true,
    added: count(change.added),
    removed: count(change.removed),
  };
}

/**
 * What the sandbox can refuse, as the tool row shows it (#792).
 *
 * @type {readonly string[]}
 */
const SANDBOX_BLOCKED_KINDS = Object.freeze(['write', 'read', 'network', 'direct']);
const SANDBOX_BLOCKED_LIMITS = Object.freeze({ ENTRIES: 20, OPERATIONS: 8, RAW_LINES: 100, CHARS: 1024 });

/**
 * What the sandbox refused during one run (#792), as it may travel to the
 * renderer and be stored with the tool row, or null. Paths, hosts and the
 * raw lines are cut to a fixed size; an entry of an unknown kind is dropped
 * rather than shown.
 *
 * @param {unknown} value
 * @returns {SandboxBlocked|null}
 */
function normalizeSandboxBlocked(value) {
  if (!isRecord(value) || !Array.isArray(value.entries)) return null;
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, SANDBOX_BLOCKED_LIMITS.CHARS) : '');
  const count = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  /** @type {SandboxBlockedEntry[]} */
  const entries = [];
  for (const raw of value.entries) {
    if (entries.length >= SANDBOX_BLOCKED_LIMITS.ENTRIES) break;
    if (!isRecord(raw) || typeof raw.kind !== 'string' || !SANDBOX_BLOCKED_KINDS.includes(raw.kind)) continue;
    const target = text(raw.target);
    if (!target) continue;
    /** @type {SandboxBlockedEntry} */
    const entry = { kind: raw.kind, target, count: Math.max(1, count(raw.count)) };
    if (raw.folder === true) entry.folder = true;
    const operations = Array.isArray(raw.operations)
      ? raw.operations.map(text).filter(Boolean).slice(0, SANDBOX_BLOCKED_LIMITS.OPERATIONS)
      : [];
    if (operations.length) entry.operations = operations;
    const reason = text(raw.reason);
    if (reason) entry.reason = reason;
    entries.push(entry);
  }
  if (entries.length === 0) return null;
  const raw = Array.isArray(value.raw)
    ? value.raw.map(text).filter(Boolean).slice(-SANDBOX_BLOCKED_LIMITS.RAW_LINES)
    : [];
  return {
    entries,
    moreEntries: count(value.moreEntries),
    total: Math.max(count(value.total), entries.length),
    raw,
  };
}

/** @type {readonly string[]} */
const SANDBOX_DECISION_OUTCOMES = Object.freeze(['allowed', 'denied', 'unanswered']);
/**
 * What a sandbox card opens (#792): a folder to write in, a path to read, a host to connect to.
 *
 * @type {readonly string[]}
 */
const SANDBOX_GRANT_KINDS = Object.freeze(['write', 'read', 'network']);

/**
 * How long a sandbox card opened something (#792): for the run, the session,
 * or — a host only — the workspace (#946). Anything else is the shortest.
 *
 * @param {unknown} value
 * @param {'run'|'session'} shortest
 * @returns {'run'|'session'|'workspace'}
 */
function sandboxDuration(value, shortest) {
  return value === 'session' || value === 'workspace' ? value : shortest;
}

/**
 * What the user decided on a sandbox card (#792), as the tool row keeps it:
 * allowed — for this run, the session or the workspace (#946), which paths, and how the retry
 * went — denied, or not answered. Null for anything else.
 *
 * @param {unknown} value
 * @returns {SandboxDecision|null}
 */
function normalizeSandboxDecision(value) {
  if (!isRecord(value) || typeof value.outcome !== 'string' || !SANDBOX_DECISION_OUTCOMES.includes(value.outcome)) return null;
  if (value.outcome !== 'allowed') return { outcome: value.outcome };
  const paths = (Array.isArray(value.paths) ? value.paths : [])
    .filter((p) => p && SANDBOX_GRANT_KINDS.includes(p.kind) && typeof p.path === 'string' && p.path)
    .slice(0, SANDBOX_BLOCKED_LIMITS.ENTRIES)
    .map((p) => ({ kind: p.kind, path: p.path.slice(0, SANDBOX_BLOCKED_LIMITS.CHARS) }));
  /** @type {SandboxDecision} */
  const out = { outcome: 'allowed', duration: sandboxDuration(value.duration, 'run'), paths };
  if (isRecord(value.retry)) {
    out.retry = { exitCode: typeof value.retry.exitCode === 'number' && Number.isInteger(value.retry.exitCode) ? value.retry.exitCode : null };
    const blocked = normalizeSandboxBlocked(value.retry.blocked);
    if (blocked) out.retry.blocked = blocked;
  }
  return out;
}

/** Connections one tool row keeps the live decisions of (#792). */
const SANDBOX_LIVE_LIMIT = 10;

/**
 * What the user decided about connections while a command waited for them
 * (#792), as the tool row keeps it: the host and port, allowed — for the run,
 * the session or the workspace (#946), and as which pattern — or denied. Empty entries and
 * anything else are dropped; null when nothing is left.
 *
 * @param {unknown} value
 * @returns {SandboxLiveEntry[]|null}
 */
function normalizeSandboxLive(value) {
  if (!Array.isArray(value)) return null;
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, SANDBOX_BLOCKED_LIMITS.CHARS) : '');
  /** @type {SandboxLiveEntry[]} */
  const out = [];
  for (const raw of value) {
    if (out.length >= SANDBOX_LIVE_LIMIT) break;
    if (!isRecord(raw) || (raw.outcome !== 'allowed' && raw.outcome !== 'denied')) continue;
    const target = text(raw.target);
    if (!target) continue;
    if (raw.outcome === 'denied') {
      out.push({ target, outcome: 'denied' });
      continue;
    }
    out.push({
      target,
      outcome: 'allowed',
      duration: sandboxDuration(raw.duration, 'run'),
      pattern: text(raw.pattern) || target,
    });
  }
  return out.length ? out : null;
}

/**
 * What the user decided on a card before a file tool reached outside the
 * open folder (#792, step 4), as the tool row keeps it: read or write, the
 * path (a folder, or a file that may hold credentials, when it was), allowed —
 * for the call or the session, and as which file or folder — or denied. Null
 * when nothing usable is left.
 *
 * @param {unknown} value
 * @returns {SandboxOutsideEntry[]|null}
 */
function normalizeSandboxOutside(value) {
  if (!Array.isArray(value)) return null;
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, SANDBOX_BLOCKED_LIMITS.CHARS) : '');
  /** @type {SandboxOutsideEntry[]} */
  const out = [];
  for (const raw of value) {
    if (out.length >= SANDBOX_LIVE_LIMIT) break;
    if (!isRecord(raw) || (raw.outcome !== 'allowed' && raw.outcome !== 'denied')) continue;
    const target = text(raw.target);
    if (!target) continue;
    const kind = raw.kind === 'write' ? 'write' : 'read';
    // What the card said about the target, kept only when it held: a folder
    // and a file that may hold credentials read differently afterwards.
    /** @type {{ folder?: true, sensitive?: true }} */
    const about = { ...(raw.folder === true ? { folder: true } : {}), ...(raw.sensitive === true ? { sensitive: true } : {}) };
    if (raw.outcome === 'denied') {
      out.push({ kind, target, outcome: 'denied', ...about });
      continue;
    }
    out.push({
      kind,
      target,
      outcome: 'allowed',
      duration: raw.duration === 'session' ? 'session' : 'call',
      pattern: text(raw.pattern) || target,
      ...about,
    });
  }
  return out.length ? out : null;
}

/**
 * chat:progress with type='workspace': a reading tool read the file (#347).
 *
 * @param {unknown} relativePath
 */
function createWorkspaceFileReadEvent(relativePath) {
  return {
    type: CHAT_PROGRESS_TYPES.WORKSPACE,
    event: WORKSPACE_PROGRESS_EVENTS.FILE_READ,
    relativePath: String(relativePath ?? ''),
  };
}

/**
 * chat:progress mit type='permission' (Issue #66). Trägt nur bereinigte
 * Daten: Tool, Aufruf-Index, Ereignis und ggf. die Entscheidung.
 *
 * @param {string} event
 * @param {{ callIndex?: number, tool?: string, response?: string, reason?: string, redactedCount?: number }} [details]
 */
function createPermissionProgressEvent(event, { callIndex, tool, response, reason, redactedCount } = {}) {
  /** @type {Record<string, unknown>} */
  const out = { type: CHAT_PROGRESS_TYPES.PERMISSION, event: String(event ?? '') };
  if (Number.isInteger(callIndex)) out.callIndex = callIndex;
  if (typeof tool === 'string' && tool) out.tool = tool;
  if (typeof response === 'string' && response) out.response = response;
  if (typeof reason === 'string' && reason) out.reason = reason;
  if (Number.isInteger(redactedCount)) out.redactedCount = redactedCount;
  return out;
}

/**
 * chat:progress mit type='phase'.
 *
 * @param {string} phase
 */
function createPhaseEvent(phase) {
  return { type: CHAT_PROGRESS_TYPES.PHASE, phase };
}

/**
 * chat:progress mit type='reasoning'.
 *
 * @param {string} text
 */
function createReasoningEvent(text) {
  return { type: CHAT_PROGRESS_TYPES.REASONING, text };
}

/** chat:progress with type='run-end': nothing of this run follows (#721). */
function createRunEndEvent() {
  return { type: CHAT_PROGRESS_TYPES.RUN_END };
}

// --- Validatoren ------------------------------------------------------------

/**
 * @param {unknown} code
 */
function isChatErrorCode(code) {
  return Object.values(CHAT_ERROR_CODES).includes(code);
}

/**
 * @param {unknown} phase
 */
function isChatPhase(phase) {
  return Object.values(CHAT_PHASES).includes(phase);
}

/**
 * @param {unknown} phase
 */
function isToolLinePhase(phase) {
  return Object.values(TOOL_LINE_PHASES).includes(phase);
}

module.exports = {
  CHAT_ID_MAX_LENGTH,
  CHAT_ACTIVATION,
  sanitizeChatId,
  CHAT_TITLE_MAX_LENGTH,
  inferChatTitle,
  inferChatTitleText,
  isDerivedChatTitle,
  isLegacyFallbackChatTitle,
  resolveChatTitle,
  sanitizeChatTitle,
  createChatResult,
  createCancelledChatResult,
  createChatErrorResult,
  createDeltaEvent,
  createToolLineEvent,
  createPhaseEvent,
  createReasoningEvent,
  createRunEndEvent,
  createWorkspaceFileWrittenEvent,
  createWorkspaceFileReadEvent,
  normalizeFileChangeSummary,
  normalizeSandboxBlocked,
  normalizeSandboxDecision,
  normalizeSandboxLive,
  normalizeSandboxOutside,
  SANDBOX_BLOCKED_KINDS,
  SANDBOX_BLOCKED_LIMITS,
  createPermissionProgressEvent,
  isChatErrorCode,
  isChatPhase,
  isToolLinePhase,
};
