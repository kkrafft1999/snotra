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
  if (text.length > CHAT_TITLE_MAX_LENGTH) {
    return `${text.slice(0, CHAT_TITLE_MAX_LENGTH - 1)}…`;
  }
  return text;
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
  if (text.length > CHAT_TITLE_MAX_LENGTH) {
    return `${text.slice(0, CHAT_TITLE_MAX_LENGTH - 1)}…`;
  }
  return text;
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
} = {}) {
  const result = { error, code };
  if (usage !== undefined) result.usage = usage;
  if (contextUsage !== undefined) result.contextUsage = contextUsage;
  if (contextBreakdown !== undefined) result.contextBreakdown = contextBreakdown;
  // Nur bei Abbruch durch verfallene Freigabe (Issue #66): die bis dahin
  // gelaufenen Tool-Schritte bleiben im Verlauf sichtbar.
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

/** chat:progress mit type='workspace' nach erfolgreichem Dateischreiben. */
function createWorkspaceFileWrittenEvent(relativePath) {
  return {
    type: CHAT_PROGRESS_TYPES.WORKSPACE,
    event: WORKSPACE_PROGRESS_EVENTS.FILE_WRITTEN,
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
  createWorkspaceFileWrittenEvent,
  createPermissionProgressEvent,
  isChatErrorCode,
  isChatPhase,
  isToolLinePhase,
};
