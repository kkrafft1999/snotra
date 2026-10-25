'use strict';

/**
 * Chat-Verlauf-Normalisierung (Stage 5).
 *
 * Single source of truth für Message-Sanitisierung, Token-Usage und die vom
 * Renderer konsumierte Loaded-Session-Form. Die Titel-Inferenz liegt in der
 * Contract-Schicht, weil die Kopfzeile im Renderer denselben Titel zeigt.
 */

const {
  inferChatTitle,
  inferChatTitleText,
  isLegacyFallbackChatTitle,
  normalizeFileChangeSummary,
  normalizeSandboxBlocked,
  normalizeSandboxDecision,
  normalizeSandboxLive,
  normalizeSandboxOutside,
} = require('../../shared/contracts/chat');
const { normalizeInjectionFlag } = require('../../shared/contracts/injection-flag');
const { normalizeSessionCost } = require('../../shared/contracts/cost');
const { createMessage, isMessage } = require('../../shared/contracts/message');
const { normalizeChatConfigOverrides } = require('../../shared/contracts/chat-configuration');
const { normalizeStoredAttachments } = require('../../shared/contracts/attachments');
const { isToolCategory } = require('../../shared/contracts/tool-categories');
const { isRecord } = require('../../shared/runtime/is-record');
const { normalizeMessageOrigin } = require('../../shared/contracts/remote/message-origin');

/**
 * A tool step as the history keeps it: the display line alone, or the line with
 * what the display derives its icon, grouping and notes from (#60, #66, #187,
 * #348, #792, #1008, #1011, #1197).
 *
 * @typedef {string | {
 *   line: string,
 *   tool?: string,
 *   skill?: string,
 *   category?: string,
 *   permission?: StoredPermissionAudit,
 *   round?: number,
 *   schema?: StoredSchemaViolations,
 *   changes?: import('../../shared/contracts/chat').FileChangeSummary[],
 *   sandboxBlocked?: import('../../shared/contracts/chat').SandboxBlocked,
 *   sandboxDecision?: import('../../shared/contracts/chat').SandboxDecision,
 *   sandboxLive?: import('../../shared/contracts/chat').SandboxLiveEntry[],
 *   sandboxOutside?: import('../../shared/contracts/chat').SandboxOutsideEntry[],
 *   injectionFlag?: import('../../shared/contracts/injection-flag').InjectionFlag,
 *   answeredBy?: { kind: string, client: string },
 * }} StoredTraceEntry
 */

/**
 * @typedef {Object} StoredPermissionAudit
 * @property {string} [decision]
 * @property {string} [source]
 * @property {string} [reason]
 * @property {string} [ruleId]
 * @property {string} [mode]
 * @property {string} [status]
 * @property {string[]} [riskClasses]
 * @property {string[]} [targets]
 * @property {true} [sensitive]
 */

/**
 * Argument paths per kind of violation, never the values (#187).
 *
 * @typedef {Partial<Record<'unknownProperties' | 'nonInteger' | 'invalidItems', string[]>>} StoredSchemaViolations
 */

/**
 * @typedef {Object} StoredUserMessage
 * @property {'user'} role
 * @property {string} content
 * @property {import('../../shared/contracts/attachments').StoredImageAttachment[]} [attachments]
 * @property {{ kind: string, client: string }} [origin]  written from the phone (#1197); absent for the window
 */

/**
 * @typedef {Object} StoredAssistantMessage
 * @property {'assistant'} role
 * @property {string} content
 * @property {true} [isError]
 * @property {true} [interrupted]  the turn was cut off before it was finished (#979)
 * @property {StoredTraceEntry[]} [toolTrace]
 * @property {string} [reasoningText]
 * @property {number} [durationMs]  how long the turn took, on its last message (#1254)
 * @property {true} [stopped]  the turn was stopped before it answered (#1254)
 */

/** @typedef {StoredUserMessage | StoredAssistantMessage} StoredMessage */

/**
 * An assistant message as the renderer loads it: every field there.
 *
 * @typedef {Object} LoadedAssistantMessage
 * @property {'assistant'} role
 * @property {string} content
 * @property {StoredTraceEntry[]} toolTrace
 * @property {string} reasoningText
 * @property {false} streaming
 * @property {boolean} isError
 * @property {true} [interrupted]
 * @property {number} [durationMs]
 * @property {true} [stopped]
 */

/** @typedef {StoredUserMessage | LoadedAssistantMessage} LoadedMessage */

/**
 * The prompt window of the last round (not a sum over the chat).
 *
 * @typedef {{ prompt: number, completion: number, total: number }} SessionTokenUsage
 */

/**
 * What a chat carries beyond its messages, each optional (#211, #725, #774, #949).
 *
 * @typedef {Object} ChatSettings
 * @property {string} [modelPresetId]
 * @property {string} [toolPermissionMode]
 * @property {string} [reasoningEffort]
 * @property {import('../../shared/contracts/chat-configuration').ChatConfigOverrides} [configOverrides]
 * @property {import('../../shared/contracts/cost').SessionCost} [cost]
 */

/**
 * The fields every form of a chat has.
 *
 * @typedef {Object} SessionBase
 * @property {string} id
 * @property {string|null} workspaceRoot
 * @property {string} title
 * @property {number} updatedAt
 * @property {SessionTokenUsage} tokenUsage
 */

/**
 * A chat in store form: what the history file holds.
 *
 * @typedef {SessionBase & ChatSettings & { messages: StoredMessage[] }} StoredSession
 */

/**
 * A chat as the renderer loads it, with its messages.
 *
 * @typedef {SessionBase & ChatSettings & { messages: LoadedMessage[] }} LoadedSession
 */

/**
 * What the history's index keeps of a chat (#985): everything but its messages.
 * `untitled` is what the list calls a chat without a title, as a descriptor.
 *
 * @typedef {SessionBase & ChatSettings & {
 *   messageCount: number,
 *   untitled?: string | import('../../shared/contracts/message').Message,
 * }} SessionMeta
 */

/**
 * A row of the history list (#985); `title` is the chat's own, or a descriptor.
 *
 * @typedef {Object} SessionListRow
 * @property {string} id
 * @property {string|null} workspaceRoot
 * @property {string|import('../../shared/contracts/message').Message} title
 * @property {number} updatedAt
 * @property {number} messageCount
 * @property {import('../../shared/contracts/cost').SessionCost} [cost]
 */

/** @typedef {(toolName: string) => (string|null)} ToolCategoryOf  the descriptor's category (#1008) */

/**
 * A chat as the renderer or a file hands it over, before it is checked: the
 * fields are what the callers pass, `messages` and the settings are looked at
 * by the normalizers.
 *
 * @typedef {Object} SessionRowInput
 * @property {string} [id]
 * @property {string|null} [workspaceRoot]
 * @property {string} [title]
 * @property {number} [updatedAt]
 * @property {unknown} [messages]
 * @property {unknown} [tokenUsage]
 * @property {unknown} [modelPresetId]
 * @property {unknown} [toolPermissionMode]
 * @property {unknown} [reasoningEffort]
 * @property {unknown} [configOverrides]
 * @property {unknown} [cost]
 */

/**
 * A chat the store already holds: it has an id and a time, and its parts are
 * normalized again on the way out.
 *
 * @typedef {SessionRowInput & { id: string, updatedAt: number }} SessionRow
 */

// A chat's own model, mode and level (#211, #725) are read by the session
// settings in the core as well (#982), so they live in the contracts.
const {
  chatModelPresetIdForStore,
  chatToolPermissionModeForStore,
  chatReasoningEffortForStore,
} = require('../../shared/contracts/chat-session-fields');

/**
 * Bild-Teil in einem Array-Content — die Formen, in denen Anbieter und Renderer
 * Bilder verpacken. Sie tragen keinen Text und duerfen nicht als JSON in den
 * Verlauf sickern; dort laege sonst genau das Base64, das Issue #94 aus der
 * Session-Datei heraushaelt.
 *
 * @param {unknown} part
 */
function isImageContentPart(part) {
  if (!isRecord(part)) return false;
  return (
    part.type === 'image' ||
    part.type === 'image_url' ||
    part.kind === 'image' ||
    typeof part.dataBase64 === 'string' ||
    typeof part.image_url === 'object' ||
    typeof part.inlineData === 'object' ||
    typeof part.source === 'object'
  );
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function messageContentForStore(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    const unknown = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
      else if (isImageContentPart(part)) continue;
      else unknown.push(part);
    }
    if (parts.length) return parts.join('\n');
    // Eine Nachricht, die nur aus Bildern bestand, hat schlicht keinen Text.
    if (unknown.length === 0) return '';
    // Only the unknown parts are kept as JSON — the image parts next to them
    // would bring their base64 along (#567).
    try {
      return JSON.stringify(unknown);
    } catch {
      return String(unknown);
    }
  }
  if (isImageContentPart(content)) return '';
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

/**
 * @param {unknown} entry
 * @returns {string}
 */
function toolTraceEntryToString(entry) {
  if (typeof entry === 'string') return entry;
  if (isRecord(entry)) {
    if (typeof entry.line === 'string') return entry.line;
    if (typeof entry.summary === 'string') return entry.summary;
    if (typeof entry.text === 'string') return entry.text;
  }
  return '';
}

/** @type {Array<'decision' | 'source' | 'reason' | 'ruleId' | 'mode' | 'status'>} */
const PERMISSION_AUDIT_STRING_KEYS = ['decision', 'source', 'reason', 'ruleId', 'mode', 'status'];

/** @type {Array<'unknownProperties' | 'nonInteger' | 'invalidItems'>} */
const SCHEMA_VIOLATION_KEYS = ['unknownProperties', 'nonInteger', 'invalidItems'];

/**
 * Bereinigter Berechtigungs-Audit-Eintrag (Issue #66) für den Verlauf:
 * Entscheidung, Quelle, Grund, Klassen, Modus, Status, Ziel-Pfade. Nie
 * Argumente, Inhalte oder Vorschauen.
 *
 * @param {unknown} raw
 * @returns {StoredPermissionAudit|undefined}
 */
function permissionAuditForStore(raw) {
  if (!isRecord(raw)) return undefined;
  /** @type {StoredPermissionAudit} */
  const out = {};
  for (const key of PERMISSION_AUDIT_STRING_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value) out[key] = value.slice(0, 64);
  }
  if (Array.isArray(raw.riskClasses)) {
    out.riskClasses = raw.riskClasses.filter((/** @type {unknown} */ c) => typeof c === 'string').slice(0, 8);
  }
  if (Array.isArray(raw.targets)) {
    out.targets = raw.targets.filter((/** @type {unknown} */ p) => typeof p === 'string').map((/** @type {string} */ p) => p.slice(0, 1024)).slice(0, 50);
  }
  if (raw.sensitive === true) out.sensitive = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Schema violations of a call (#187) for the history: argument paths per
 * kind, capped. The paths come from the model, so they are bounded like any
 * other foreign string; values never get here.
 *
 * @param {unknown} raw
 * @returns {StoredSchemaViolations|undefined}
 */
function schemaViolationsForStore(raw) {
  if (!isRecord(raw)) return undefined;
  /** @type {StoredSchemaViolations} */
  const out = {};
  for (const key of SCHEMA_VIOLATION_KEYS) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    const paths = list.filter((p) => typeof p === 'string' && p).map((p) => p.slice(0, 128)).slice(0, 32);
    if (paths.length) out[key] = paths;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Trace-Eintrag für Speicher und Renderer. Ist der Tool-Name bekannt, bleibt
 * er als `{ line, tool }` erhalten — daraus leitet die Anzeige Symbol und
 * gruppierte Zusammenfassung ab (Issue #60). Ohne Tool-Namen bleibt es bei der
 * bisherigen reinen Zeichenkette, damit alte Verläufe unverändert durchgehen.
 *
 * @param {unknown} entry
 * @param {ToolCategoryOf|null} [toolCategoryOf]
 * @returns {StoredTraceEntry}
 */
function toolTraceEntryForStore(entry, toolCategoryOf = null) {
  const line = toolTraceEntryToString(entry);
  if (!line) return '';
  /** @type {Record<string, unknown>} */
  const fields = isRecord(entry) ? entry : {};
  const tool = typeof fields.tool === 'string' && fields.tool ? fields.tool : '';
  const skill = typeof fields.skill === 'string' && fields.skill ? fields.skill : '';
  // The tool's category (#1008). An entry stored before it carried one gets
  // it from the descriptor on the way out, so its icon stays what it was.
  let category = isToolCategory(fields.category) ? fields.category : '';
  if (!category && tool && typeof toolCategoryOf === 'function') {
    const known = toolCategoryOf(tool);
    if (isToolCategory(known)) category = known;
  }
  const permission = permissionAuditForStore(fields.permission);
  const round = typeof fields.round === 'number' && Number.isInteger(fields.round) && fields.round > 0 ? fields.round : 0;
  const schema = schemaViolationsForStore(fields.schema);
  const changes = fileChangesForStore(fields.changes);
  // What the sandbox refused (#792): kinds, paths and hosts, never output.
  const sandboxBlocked = normalizeSandboxBlocked(fields.sandboxBlocked);
  const sandboxDecision = sandboxBlocked ? normalizeSandboxDecision(fields.sandboxDecision) : null;
  // What the user decided about connections while a command waited (#792).
  const sandboxLive = normalizeSandboxLive(fields.sandboxLive);
  // …and on a card before a file tool reached outside the open folder (#792, step 4).
  const sandboxOutside = normalizeSandboxOutside(fields.sandboxOutside);
  // A result that looked like a prompt injection (#1011): kinds and short excerpts.
  const injectionFlag = normalizeInjectionFlag(fields.injectionFlag);
  // Who answered the call's card, when it was the phone (#1197).
  const answeredBy = normalizeMessageOrigin(fields.answeredBy);
  if (!tool && !skill && !permission && !round && !schema && !changes && !sandboxBlocked && !sandboxLive && !sandboxOutside && !injectionFlag && !answeredBy) return line;
  /** @type {Exclude<StoredTraceEntry, string>} */
  const out = { line };
  if (tool) out.tool = tool;
  if (skill) out.skill = skill;
  if (category) out.category = category;
  if (permission) out.permission = permission;
  if (round) out.round = round;
  if (schema) out.schema = schema;
  if (changes) out.changes = changes;
  if (sandboxBlocked) out.sandboxBlocked = sandboxBlocked;
  if (sandboxDecision) out.sandboxDecision = sandboxDecision;
  if (sandboxLive) out.sandboxLive = sandboxLive;
  if (sandboxOutside) out.sandboxOutside = sandboxOutside;
  if (injectionFlag) out.injectionFlag = injectionFlag;
  if (answeredBy) out.answeredBy = answeredBy;
  return out;
}

/**
 * The summaries of what a writing call changed (#348): ids and counts, never
 * content. A patch touches at most 20 files; more than that is not a call.
 */
const MAX_STORED_CHANGES = 20;
/**
 * @param {unknown} raw
 */
function fileChangesForStore(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.slice(0, MAX_STORED_CHANGES).map(normalizeFileChangeSummary).filter((change) => change !== null);
  return out.length ? out : undefined;
}

/**
 * @param {unknown} raw
 * @returns {StoredTraceEntry[]|undefined}
 */
function sanitizeToolTraceForStore(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = raw.map((entry) => toolTraceEntryForStore(entry)).filter((entry) => entry !== '');
  return out.length ? out : undefined;
}

/**
 * How long a turn took and whether it was stopped (#1254). A turn cut off
 * mid-run never got its duration; a chat from before has none and loads as it
 * was.
 *
 * @param {Record<string, unknown>} from
 * @param {{ durationMs?: number, stopped?: true }} row
 */
function copyTurnDuration(from, row) {
  const ms = from.durationMs;
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) row.durationMs = Math.round(ms);
  if (from.stopped === true) row.stopped = true;
}

/**
 * @param {StoredAssistantMessage} row
 */
function isStoredAssistantMessageWorthKeeping(row) {
  if (row.isError === true) return true;
  // A turn cut off before its first step still says so after a restart (#979).
  if (row.interrupted === true) return true;
  if (row.toolTrace && row.toolTrace.length > 0) return true;
  if (row.reasoningText && row.reasoningText.length > 0) return true;
  return !!(row.content && row.content.trim());
}

/**
 * @param {LoadedMessage|null} message
 * @returns {message is LoadedMessage}
 */
function isLoadedMessageWorthKeeping(message) {
  if (!message) return false;
  // Ein Screenshot ohne Begleitfrage ist eine vollwertige Nachricht (#94).
  if (message.role === 'user') {
    return message.content.trim().length > 0 || (message.attachments?.length ?? 0) > 0;
  }
  return (
    message.isError ||
    message.interrupted === true ||
    message.toolTrace.length > 0 ||
    message.reasoningText.trim().length > 0 ||
    message.content.trim().length > 0
  );
}

/**
 * @param {unknown} raw
 * @returns {StoredMessage[]}
 */
function sanitizeChatMessagesForStore(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {StoredMessage[]} */
  const out = [];
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = messageContentForStore(m.content);
    if (m.role === 'user') {
      // Anhaenge kommen hier ausschliesslich als Datei-Referenz an: die
      // Bilddaten hat die Anhang-Ablage vorher auf die Platte geschrieben
      // (Issue #94). Base64 wird bewusst nicht uebernommen.
      const attachments = normalizeStoredAttachments(m.attachments);
      if (!content.trim() && attachments.length === 0) continue;
      /** @type {StoredUserMessage} */
      const row = { role: 'user', content };
      if (attachments.length) row.attachments = attachments;
      const origin = normalizeMessageOrigin(m.origin);
      if (origin) row.origin = origin;
      out.push(row);
      continue;
    }
    /** @type {StoredAssistantMessage} */
    const row = { role: 'assistant', content };
    if (m.isError === true) row.isError = true;
    // A turn written while its run is still going (#979) is stored as cut off.
    // The write after the run settles drops the mark again; when that write
    // never comes — a crash, a quit, a reload — the mark is what is left.
    if (m.streaming === true || m.interrupted === true) row.interrupted = true;
    const toolTrace = sanitizeToolTraceForStore(m.toolTrace);
    if (toolTrace) row.toolTrace = toolTrace;
    if (typeof m.reasoningText === 'string' && m.reasoningText.trim()) {
      row.reasoningText = m.reasoningText.trim();
    }
    copyTurnDuration(m, row);
    if (!isStoredAssistantMessageWorthKeeping(row)) continue;
    out.push(row);
  }
  return out;
}

/* tokenUsage einer Session ist die Usage der letzten LLM-Runde (deren prompt
 * = zuletzt gesendetes Kontextfenster), keine Summe ueber den Chat. Aeltere
 * Sessions tragen noch Summenwerte; die korrigieren sich mit dem naechsten Zug. */
/**
 * @param {unknown} raw
 * @returns {SessionTokenUsage}
 */
function normalizeTokenUsageForStore(raw) {
  if (!isRecord(raw)) {
    return { prompt: 0, completion: 0, total: 0 };
  }
  const prompt = Math.max(0, Math.round(Number(raw.prompt) || 0));
  const completion = Math.max(0, Math.round(Number(raw.completion) || 0));
  let total = Math.max(0, Math.round(Number(raw.total) || 0));
  if (total === 0 && (prompt > 0 || completion > 0)) {
    total = prompt + completion;
  }
  return { prompt, completion, total };
}

/**
 * @param {unknown} raw
 * @param {ToolCategoryOf|null} [toolCategoryOf]
 * @returns {LoadedMessage[]}
 */
function normalizeLoadedMessages(raw, toolCategoryOf = null) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
      if (m.role === 'user') {
        /** @type {StoredUserMessage} */
        const row = { role: 'user', content: messageContentForStore(m.content) };
        // Die Bilddaten holt der Renderer erst beim Anzeigen nach (#94) —
        // saemtliche Sessions eines Ordners auf einmal waeren zu viel.
        const attachments = normalizeStoredAttachments(m.attachments);
        if (attachments.length) row.attachments = attachments;
        // Where it was written (#1197); a chat from before has none and loads as it was.
        const origin = normalizeMessageOrigin(m.origin);
        if (origin) row.origin = origin;
        return row;
      }
      const toolTrace = Array.isArray(m.toolTrace)
        ? m.toolTrace.map((/** @type {unknown} */ entry) => toolTraceEntryForStore(entry, toolCategoryOf)).filter((/** @type {StoredTraceEntry} */ e) => e !== '')
        : [];
      /** @type {LoadedAssistantMessage} */
      const row = {
        role: 'assistant',
        content: messageContentForStore(m.content),
        toolTrace,
        reasoningText: typeof m.reasoningText === 'string' ? m.reasoningText : '',
        streaming: false,
        isError: Boolean(m.isError),
      };
      if (m.interrupted === true) row.interrupted = true;
      copyTurnDuration(m, row);
      return row;
    })
    .filter(isLoadedMessageWorthKeeping);
}

/**
 * Feldweiser Vergleich zweier Werte in Ablageform — reihenfolgenunabhaengig,
 * damit eine aeltere Verlaufsdatei nicht allein wegen einer anderen
 * Schluesselreihenfolge als veraendert gilt.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameStoredValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => sameStoredValue(value, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    if (keysA.some((key, i) => key !== keysB[i])) return false;
    return keysA.every((key) => sameStoredValue(a[key], b[key]));
  }
  return false;
}

/**
 * Hat seit dem letzten Speichern ein Zug stattgefunden (Issue #245)?
 *
 * `updatedAt` soll die letzte Interaktion mit dem Sprachmodell nennen, nicht
 * den letzten Schreibvorgang. Sonst wandert ein Chat auf „heute“, nur weil man
 * ihn geoeffnet, das Modell gewechselt oder den Titel hat nachziehen lassen —
 * alles drei schreibt die Session, ohne dass ein Wort gewechselt wurde.
 *
 * Verglichen wird die Anzahl und die letzte Nachricht: Der Verlauf waechst nur
 * hinten, ein Zug aendert damit immer mindestens eines von beidem. Die
 * gespeicherte Seite laeuft vorher noch einmal durch die Sanitisierung, damit
 * ein Verlauf aus einer aelteren Version nicht schon durch das Nachziehen
 * seiner Form als veraendert zaehlt.
 *
 * @param {unknown} existingMessages
 * @param {unknown} nextMessages
 * @returns {boolean}
 */
function storedChatMessagesChanged(existingMessages, nextMessages) {
  const before = sanitizeChatMessagesForStore(existingMessages);
  /** @type {unknown[]} */
  const after = Array.isArray(nextMessages) ? nextMessages : [];
  if (before.length !== after.length) return true;
  if (after.length === 0) return false;
  return !sameStoredValue(before[before.length - 1], after[after.length - 1]);
}

/**
 * A chat without a title of its own is stored with its text-derived title, or
 * with none at all: a fallback like "New chat" is worked out when the chat is
 * shown, in the language it is shown in (#359). German fallbacks written by
 * older versions are dropped on the way, so the next write migrates them.
 *
 * @param {{ title?: unknown }} sessionRow
 * @param {unknown} messages
 * @param {unknown} existingTitle
 * @returns {string}
 */
function resolveSessionTitle(sessionRow, messages, existingTitle) {
  const own = (/** @type {unknown} */ value) => {
    const title = typeof value === 'string' ? value.trim() : '';
    return title && !isLegacyFallbackChatTitle(title, messages) ? title : '';
  };
  return own(sessionRow.title) || own(existingTitle) || inferChatTitleText(messages);
}

/**
 * The settings a chat carries beyond its messages, each optional: model and
 * permission mode (#211), reasoning level (#725), what it switched for itself
 * (#774) and its estimated cost (#949). Copied in this order, so that every
 * form of a session lists its fields alike.
 *
 * @template {object} T
 * @param {SessionRowInput} from
 * @param {T & ChatSettings} out
 * @returns {T & ChatSettings}
 */
function copyChatSettings(from, out) {
  const modelPresetId = chatModelPresetIdForStore(from.modelPresetId);
  if (modelPresetId) out.modelPresetId = modelPresetId;
  const toolPermissionMode = chatToolPermissionModeForStore(from.toolPermissionMode);
  if (toolPermissionMode) out.toolPermissionMode = toolPermissionMode;
  const reasoningEffort = chatReasoningEffortForStore(from.reasoningEffort);
  if (reasoningEffort) out.reasoningEffort = reasoningEffort;
  const configOverrides = normalizeChatConfigOverrides(from.configOverrides);
  if (configOverrides) out.configOverrides = configOverrides;
  const cost = normalizeSessionCost(from.cost);
  if (cost) out.cost = cost;
  return out;
}

/**
 * @param {SessionRowInput|null|undefined} sessionRow
 * @param {{ normalizeWorkspaceRoot?: (raw: unknown) => string|null, existingTitle?: string, requireMessages?: boolean }} [options]
 * @returns {StoredSession|null}
 */
function normalizeSessionForStore(sessionRow, { normalizeWorkspaceRoot, existingTitle, requireMessages = false } = {}) {
  if (!sessionRow || typeof sessionRow.id !== 'string' || !sessionRow.id.trim()) return null;
  const messages = sanitizeChatMessagesForStore(sessionRow.messages);
  if (requireMessages && messages.length === 0) return null;
  const title = resolveSessionTitle(sessionRow, messages, existingTitle);
  const workspaceRoot =
    typeof normalizeWorkspaceRoot === 'function'
      ? normalizeWorkspaceRoot(sessionRow.workspaceRoot)
      : sessionRow.workspaceRoot || null;
  return copyChatSettings(sessionRow, {
    id: sessionRow.id.trim(),
    workspaceRoot,
    title: title.slice(0, 200),
    updatedAt: typeof sessionRow.updatedAt === 'number' && Number.isFinite(sessionRow.updatedAt) ? sessionRow.updatedAt : Date.now(),
    messages,
    tokenUsage: normalizeTokenUsageForStore(sessionRow.tokenUsage),
  });
}

/**
 * @param {SessionRow|null|undefined} sessionRow
 * @param {{ toolCategoryOf?: ToolCategoryOf|null }} [options]
 * @returns {LoadedSession|null}
 */
function normalizeSessionForLoad(sessionRow, { toolCategoryOf = null } = {}) {
  if (!sessionRow || typeof sessionRow !== 'object') return null;
  return copyChatSettings(sessionRow, {
    id: sessionRow.id,
    workspaceRoot: sessionRow.workspaceRoot ?? null,
    title: typeof sessionRow.title === 'string' ? sessionRow.title : '',
    updatedAt: sessionRow.updatedAt,
    messages: normalizeLoadedMessages(sessionRow.messages, toolCategoryOf),
    tokenUsage: normalizeTokenUsageForStore(sessionRow.tokenUsage),
  });
}

/**
 * What the history's index keeps of a chat (#985): everything but its
 * messages, plus how many of them a reader gets and, for a chat without a
 * title, what the list calls it instead. Built from a session in store form,
 * so the list, the folder pointers and the chat's own settings are answered
 * without opening the chat's file.
 *
 * @param {SessionRow} session
 * @returns {SessionMeta}
 */
function sessionMetaFromSession(session) {
  const loaded = normalizeLoadedMessages(session.messages);
  /** @type {SessionMeta} */
  const meta = copyChatSettings(session, {
    id: session.id,
    workspaceRoot: session.workspaceRoot ?? null,
    title: typeof session.title === 'string' ? session.title : '',
    updatedAt: session.updatedAt,
    messageCount: loaded.length,
    tokenUsage: normalizeTokenUsageForStore(session.tokenUsage),
  });
  // "Image", "3 images" or "New chat" — a descriptor, worked out in the
  // language the list is shown in (#359).
  if (!meta.title) meta.untitled = inferChatTitle(loaded);
  return meta;
}

/**
 * An index entry as read back from the disk; `null` for one that is no entry.
 *
 * @param {unknown} raw
 * @param {{ normalizeWorkspaceRoot?: (raw: unknown) => string|null }} [options]
 * @returns {SessionMeta|null}
 */
function normalizeSessionMetaForStore(raw, { normalizeWorkspaceRoot } = {}) {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  /** @type {SessionMeta} */
  const meta = copyChatSettings(raw, {
    id: raw.id.trim(),
    workspaceRoot:
      typeof normalizeWorkspaceRoot === 'function'
        ? normalizeWorkspaceRoot(raw.workspaceRoot)
        : (typeof raw.workspaceRoot === 'string' && raw.workspaceRoot) || null,
    title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '',
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    messageCount: typeof raw.messageCount === 'number' && Number.isInteger(raw.messageCount) && raw.messageCount > 0 ? raw.messageCount : 0,
    tokenUsage: normalizeTokenUsageForStore(raw.tokenUsage),
  });
  if (!meta.title && isMessage(raw.untitled)) meta.untitled = createMessage(raw.untitled.key, raw.untitled.params);
  return meta;
}

/**
 * A chat as the history list gets it (#985): no messages, only what a row
 * shows and what picks the chat a folder opens with. `title` is what the row
 * says — the chat's own title, or a message descriptor when it has none.
 *
 * @param {SessionMeta|null|undefined} meta
 * @returns {SessionListRow|null}
 */
function normalizeSessionMetaForList(meta) {
  if (!meta || typeof meta !== 'object' || typeof meta.id !== 'string') return null;
  /** @type {SessionListRow} */
  const out = {
    id: meta.id,
    workspaceRoot: meta.workspaceRoot ?? null,
    title: meta.title || (isMessage(meta.untitled) ? meta.untitled : createMessage('chat.title.new')),
    updatedAt: meta.updatedAt,
    messageCount: Number.isInteger(meta.messageCount) ? meta.messageCount : 0,
  };
  const cost = normalizeSessionCost(meta.cost);
  if (cost) out.cost = cost;
  return out;
}

/**
 * A whole chat in store form, from its index entry and the messages of its
 * file. The entry wins for everything else: a chat's own settings are written
 * to the index alone when they change (#985).
 *
 * @param {SessionMeta} meta
 * @param {StoredMessage[]} messages
 * @returns {StoredSession}
 */
function sessionFromMeta(meta, messages) {
  return copyChatSettings(meta, {
    id: meta.id,
    workspaceRoot: meta.workspaceRoot ?? null,
    title: meta.title,
    updatedAt: meta.updatedAt,
    messages,
    tokenUsage: normalizeTokenUsageForStore(meta.tokenUsage),
  });
}

module.exports = {
  inferChatTitle,
  chatModelPresetIdForStore,
  chatToolPermissionModeForStore,
  chatReasoningEffortForStore,
  toolTraceEntryToString,
  toolTraceEntryForStore,
  sanitizeChatMessagesForStore,
  storedChatMessagesChanged,
  normalizeTokenUsageForStore,
  normalizeLoadedMessages,
  normalizeSessionForStore,
  normalizeSessionForLoad,
  sessionMetaFromSession,
  normalizeSessionMetaForStore,
  normalizeSessionMetaForList,
  sessionFromMeta,
};
