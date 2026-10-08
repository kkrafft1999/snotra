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
 * @returns {string|{ key: string, params?: object }}
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
 */
function sanitizeChatTitle(raw) {
  if (raw == null) return '';
  let text = String(raw).split('\n').find((line) => line.trim()) || '';
  text = text.trim().replace(/\s+/g, ' ');
  // Manche Modelle verpacken die Ueberschrift in Anfuehrungszeichen, stellen
  // ein „Titel:“ voran — oder beides, in beliebiger Schachtelung. Deshalb
  // zweimal abtragen: aussen die Zeichen, dann der Vorsatz, dann erneut.
  const unquote = (value) => value.replace(/^["'«»„“”‚‘’]+/, '').replace(/["'«»„“”‚‘’]+$/, '').trim();
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

/** Erfolgreiches Chat-Ergebnis (Modell hat geantwortet, keine Tools mehr offen). */
function createChatResult({
  content = '',
  toolTrace = [],
  usage = null,
  contextUsage,
  contextBreakdown,
} = {}) {
  const result = { content, toolTrace, usage };
  if (contextUsage !== undefined) result.contextUsage = contextUsage;
  if (contextBreakdown !== undefined) result.contextBreakdown = contextBreakdown;
  return result;
}

/** Vom Nutzer bzw. per AbortSignal abgebrochenes Chat-Ergebnis. */
function createCancelledChatResult({
  content = '',
  toolTrace = [],
  usage = null,
  contextUsage,
  contextBreakdown,
} = {}) {
  const result = { cancelled: true, content, toolTrace, usage };
  if (contextUsage !== undefined) result.contextUsage = contextUsage;
  if (contextBreakdown !== undefined) result.contextBreakdown = contextBreakdown;
  return result;
}

/**
 * Fehler-Ergebnis. usage/contextUsage werden nur aufgenommen, wenn sie
 * übergeben wurden — Frühabbrüche (z. B. leere Nachricht) bleiben so bei der
 * schlanken Form { error, code }, wie sie der Renderer erwartet.
 */
function createChatErrorResult({
  error,
  code = CHAT_ERROR_CODES.INVALID,
  usage,
  contextUsage,
  contextBreakdown,
  toolTrace,
  partial = false,
} = {}) {
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

/** chat:delta — ein Stück Antwort-Text. */
function createDeltaEvent(text) {
  return { text: String(text ?? '') };
}

/**
 * chat:tool-line — Tool-Ereignis mit Anzeige-Zeile und optionalen Rohdaten.
 * entry = { line, tool?, args?, waitMs?, noWorkspace? }.
 * `line` ist die fertige UI-Zeile; tool/args bleiben für Debugging/Kompatibilität.
 */
function createToolLineEvent(phase, entry) {
  return { phase, ...entry };
}

/**
 * chat:progress mit type='workspace' nach erfolgreichem Dateischreiben.
 * `change` is the recorder's summary of the write (#348), without content:
 * `{ id, relativePath, status, created, added, removed }`.
 */
function createWorkspaceFileWrittenEvent(relativePath, change = null) {
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
const FILE_CHANGE_STATUSES = new Set(['text', 'unchanged', 'eol-only', 'binary', 'too-large']);

/**
 * A change summary as it may travel and be stored (#348), or null. Counts are
 * whole numbers; anything else is dropped rather than shown.
 */
function normalizeFileChangeSummary(change) {
  if (!change || typeof change !== 'object') return null;
  const id = typeof change.id === 'string' ? change.id : '';
  if (!FILE_CHANGE_ID_PATTERN.test(id)) return null;
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    id,
    relativePath: typeof change.relativePath === 'string' ? change.relativePath.slice(0, 4096) : '',
    status: FILE_CHANGE_STATUSES.has(change.status) ? change.status : 'text',
    created: change.created === true,
    added: count(change.added),
    removed: count(change.removed),
  };
}

/** What the sandbox can refuse, as the tool row shows it (#792). */
const SANDBOX_BLOCKED_KINDS = Object.freeze(['write', 'read', 'network', 'direct']);
const SANDBOX_BLOCKED_LIMITS = Object.freeze({ ENTRIES: 20, OPERATIONS: 8, RAW_LINES: 100, CHARS: 1024 });

/**
 * What the sandbox refused during one run (#792), as it may travel to the
 * renderer and be stored with the tool row, or null. Paths, hosts and the
 * raw lines are cut to a fixed size; an entry of an unknown kind is dropped
 * rather than shown.
 */
function normalizeSandboxBlocked(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return null;
  const text = (v) => (typeof v === 'string' ? v.slice(0, SANDBOX_BLOCKED_LIMITS.CHARS) : '');
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const entries = [];
  for (const raw of value.entries) {
    if (entries.length >= SANDBOX_BLOCKED_LIMITS.ENTRIES) break;
    if (!raw || typeof raw !== 'object' || !SANDBOX_BLOCKED_KINDS.includes(raw.kind)) continue;
    const target = text(raw.target);
    if (!target) continue;
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

const SANDBOX_DECISION_OUTCOMES = Object.freeze(['allowed', 'denied', 'unanswered']);

/**
 * What the user decided on a sandbox card (#792), as the tool row keeps it:
 * allowed — for this run or the session, which paths, and how the retry
 * went — denied, or not answered. Null for anything else.
 */
function normalizeSandboxDecision(value) {
  if (!value || typeof value !== 'object' || !SANDBOX_DECISION_OUTCOMES.includes(value.outcome)) return null;
  if (value.outcome !== 'allowed') return { outcome: value.outcome };
  const paths = (Array.isArray(value.paths) ? value.paths : [])
    .filter((p) => p && (p.kind === 'write' || p.kind === 'read') && typeof p.path === 'string' && p.path)
    .slice(0, SANDBOX_BLOCKED_LIMITS.ENTRIES)
    .map((p) => ({ kind: p.kind, path: p.path.slice(0, SANDBOX_BLOCKED_LIMITS.CHARS) }));
  const out = { outcome: 'allowed', duration: value.duration === 'session' ? 'session' : 'run', paths };
  if (value.retry && typeof value.retry === 'object') {
    out.retry = { exitCode: Number.isInteger(value.retry.exitCode) ? value.retry.exitCode : null };
    const blocked = normalizeSandboxBlocked(value.retry.blocked);
    if (blocked) out.retry.blocked = blocked;
  }
  return out;
}

/** chat:progress with type='workspace': a reading tool read the file (#347). */
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
 */
function createPermissionProgressEvent(event, { callIndex, tool, response, reason, redactedCount } = {}) {
  const out = { type: CHAT_PROGRESS_TYPES.PERMISSION, event: String(event ?? '') };
  if (Number.isInteger(callIndex)) out.callIndex = callIndex;
  if (typeof tool === 'string' && tool) out.tool = tool;
  if (typeof response === 'string' && response) out.response = response;
  if (typeof reason === 'string' && reason) out.reason = reason;
  if (Number.isInteger(redactedCount)) out.redactedCount = redactedCount;
  return out;
}

/** chat:progress mit type='phase'. */
function createPhaseEvent(phase) {
  return { type: CHAT_PROGRESS_TYPES.PHASE, phase };
}

/** chat:progress mit type='reasoning'. */
function createReasoningEvent(text) {
  return { type: CHAT_PROGRESS_TYPES.REASONING, text };
}

/** chat:progress with type='run-end': nothing of this run follows (#721). */
function createRunEndEvent() {
  return { type: CHAT_PROGRESS_TYPES.RUN_END };
}

// --- Validatoren ------------------------------------------------------------

function isChatErrorCode(code) {
  return Object.values(CHAT_ERROR_CODES).includes(code);
}

function isChatPhase(phase) {
  return Object.values(CHAT_PHASES).includes(phase);
}

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
  SANDBOX_BLOCKED_KINDS,
  SANDBOX_BLOCKED_LIMITS,
  createPermissionProgressEvent,
  isChatErrorCode,
  isChatPhase,
  isToolLinePhase,
};
