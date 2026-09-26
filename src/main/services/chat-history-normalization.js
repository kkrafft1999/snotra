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
} = require('../../shared/contracts/chat');
const { normalizeStoredAttachments } = require('../../shared/contracts/attachments');
const { TOOL_PERMISSION_MODES } = require('../../shared/contracts/tool-permissions');

const TOOL_PERMISSION_MODE_VALUES = Object.freeze(Object.values(TOOL_PERMISSION_MODES));

/**
 * Modell und Freigabemodus eines Chats (Issue #211). Beides ist optional: Ein
 * Verlauf aus einer aelteren Version kennt die Felder nicht, und ein Chat ohne
 * eigene Wahl soll auch keine bekommen — er faellt auf den Standard zurueck.
 */
function chatModelPresetIdForStore(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

/**
 * Nur die drei bekannten Modi. Ein unbekannter Wert wird verworfen statt auf
 * `smart` normalisiert: „nichts gespeichert“ und „ausdruecklich intelligent“
 * sind derselbe Lauf, aber nicht dieselbe Aussage — und ein zugespielter Wert
 * darf hier auf keinen Fall zu einer Freigabe werden.
 */
function chatToolPermissionModeForStore(raw) {
  if (typeof raw !== 'string') return undefined;
  return TOOL_PERMISSION_MODE_VALUES.includes(raw) ? raw : undefined;
}

/**
 * Bild-Teil in einem Array-Content — die Formen, in denen Anbieter und Renderer
 * Bilder verpacken. Sie tragen keinen Text und duerfen nicht als JSON in den
 * Verlauf sickern; dort laege sonst genau das Base64, das Issue #94 aus der
 * Session-Datei heraushaelt.
 */
function isImageContentPart(part) {
  if (!part || typeof part !== 'object') return false;
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

function messageContentForStore(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    let unknown = false;
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
      else if (isImageContentPart(part)) continue;
      else unknown = true;
    }
    if (parts.length) return parts.join('\n');
    // Eine Nachricht, die nur aus Bildern bestand, hat schlicht keinen Text.
    if (!unknown) return '';
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function toolTraceEntryToString(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    if (typeof entry.line === 'string') return entry.line;
    if (typeof entry.summary === 'string') return entry.summary;
    if (typeof entry.text === 'string') return entry.text;
  }
  return '';
}

/**
 * Trace-Eintrag für Speicher und Renderer. Ist der Tool-Name bekannt, bleibt
 * er als `{ line, tool }` erhalten — daraus leitet die Anzeige Symbol und
 * gruppierte Zusammenfassung ab (Issue #60). Ohne Tool-Namen bleibt es bei der
 * bisherigen reinen Zeichenkette, damit alte Verläufe unverändert durchgehen.
 */
/**
 * Bereinigter Berechtigungs-Audit-Eintrag (Issue #66) für den Verlauf:
 * Entscheidung, Quelle, Grund, Klassen, Modus, Status, Ziel-Pfade. Nie
 * Argumente, Inhalte oder Vorschauen.
 */
function permissionAuditForStore(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const key of ['decision', 'source', 'reason', 'ruleId', 'mode', 'status']) {
    if (typeof raw[key] === 'string' && raw[key]) out[key] = raw[key].slice(0, 64);
  }
  if (Array.isArray(raw.riskClasses)) {
    out.riskClasses = raw.riskClasses.filter((c) => typeof c === 'string').slice(0, 8);
  }
  if (Array.isArray(raw.targets)) {
    out.targets = raw.targets.filter((p) => typeof p === 'string').map((p) => p.slice(0, 1024)).slice(0, 50);
  }
  if (raw.sensitive === true) out.sensitive = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Schema violations of a call (#187) for the history: argument paths per
 * kind, capped. The paths come from the model, so they are bounded like any
 * other foreign string; values never get here.
 */
function schemaViolationsForStore(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const key of ['unknownProperties', 'nonInteger', 'invalidItems']) {
    if (!Array.isArray(raw[key])) continue;
    const paths = raw[key].filter((p) => typeof p === 'string' && p).map((p) => p.slice(0, 128)).slice(0, 32);
    if (paths.length) out[key] = paths;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toolTraceEntryForStore(entry) {
  const line = toolTraceEntryToString(entry);
  if (!line) return '';
  const tool = typeof entry?.tool === 'string' && entry.tool ? entry.tool : '';
  const skill = typeof entry?.skill === 'string' && entry.skill ? entry.skill : '';
  const permission = permissionAuditForStore(entry?.permission);
  const round = Number.isInteger(entry?.round) && entry.round > 0 ? entry.round : 0;
  const schema = schemaViolationsForStore(entry?.schema);
  if (!tool && !skill && !permission && !round && !schema) return line;
  const out = { line };
  if (tool) out.tool = tool;
  if (skill) out.skill = skill;
  if (permission) out.permission = permission;
  if (round) out.round = round;
  if (schema) out.schema = schema;
  return out;
}

function sanitizeToolTraceForStore(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = raw.map(toolTraceEntryForStore).filter((e) => e !== '');
  return out.length ? out : undefined;
}

function isStoredAssistantMessageWorthKeeping(row) {
  if (row.isError === true) return true;
  if (row.toolTrace && row.toolTrace.length > 0) return true;
  if (row.reasoningText && row.reasoningText.length > 0) return true;
  return !!(row.content && row.content.trim());
}

function isLoadedMessageWorthKeeping(message) {
  if (!message) return false;
  // Ein Screenshot ohne Begleitfrage ist eine vollwertige Nachricht (#94).
  if (message.role === 'user') {
    return message.content.trim().length > 0 || (message.attachments?.length ?? 0) > 0;
  }
  return (
    message.isError ||
    message.toolTrace.length > 0 ||
    message.reasoningText.trim().length > 0 ||
    message.content.trim().length > 0
  );
}

function sanitizeChatMessagesForStore(raw) {
  if (!Array.isArray(raw)) return [];
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
      const row = { role: 'user', content };
      if (attachments.length) row.attachments = attachments;
      out.push(row);
      continue;
    }
    const row = { role: 'assistant', content };
    if (m.isError === true) row.isError = true;
    const toolTrace = sanitizeToolTraceForStore(m.toolTrace);
    if (toolTrace) row.toolTrace = toolTrace;
    if (typeof m.reasoningText === 'string' && m.reasoningText.trim()) {
      row.reasoningText = m.reasoningText.trim();
    }
    if (!isStoredAssistantMessageWorthKeeping(row)) continue;
    out.push(row);
  }
  return out;
}

/* tokenUsage einer Session ist die Usage der letzten LLM-Runde (deren prompt
 * = zuletzt gesendetes Kontextfenster), keine Summe ueber den Chat. Aeltere
 * Sessions tragen noch Summenwerte; die korrigieren sich mit dem naechsten Zug. */
function normalizeTokenUsageForStore(raw) {
  if (!raw || typeof raw !== 'object') {
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

function normalizeLoadedMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
      if (m.role === 'user') {
        const row = { role: 'user', content: messageContentForStore(m.content) };
        // Die Bilddaten holt der Renderer erst beim Anzeigen nach (#94) —
        // saemtliche Sessions eines Ordners auf einmal waeren zu viel.
        const attachments = normalizeStoredAttachments(m.attachments);
        if (attachments.length) row.attachments = attachments;
        return row;
      }
      const toolTrace = Array.isArray(m.toolTrace)
        ? m.toolTrace.map(toolTraceEntryForStore).filter((e) => e !== '')
        : [];
      return {
        role: 'assistant',
        content: messageContentForStore(m.content),
        toolTrace,
        reasoningText: typeof m.reasoningText === 'string' ? m.reasoningText : '',
        streaming: false,
        isError: Boolean(m.isError),
      };
    })
    .filter(isLoadedMessageWorthKeeping);
}

/**
 * Feldweiser Vergleich zweier Werte in Ablageform — reihenfolgenunabhaengig,
 * damit eine aeltere Verlaufsdatei nicht allein wegen einer anderen
 * Schluesselreihenfolge als veraendert gilt.
 */
function sameStoredValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => sameStoredValue(value, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
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
 */
function storedChatMessagesChanged(existingMessages, nextMessages) {
  const before = sanitizeChatMessagesForStore(existingMessages);
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
 */
function resolveSessionTitle(sessionRow, messages, existingTitle) {
  const own = (value) => {
    const title = typeof value === 'string' ? value.trim() : '';
    return title && !isLegacyFallbackChatTitle(title, messages) ? title : '';
  };
  return own(sessionRow.title) || own(existingTitle) || inferChatTitleText(messages);
}

function normalizeSessionForStore(sessionRow, { normalizeWorkspaceRoot, existingTitle, requireMessages = false } = {}) {
  if (!sessionRow || typeof sessionRow.id !== 'string' || !sessionRow.id.trim()) return null;
  const messages = sanitizeChatMessagesForStore(sessionRow.messages);
  if (requireMessages && messages.length === 0) return null;
  const title = resolveSessionTitle(sessionRow, messages, existingTitle);
  const workspaceRoot =
    typeof normalizeWorkspaceRoot === 'function'
      ? normalizeWorkspaceRoot(sessionRow.workspaceRoot)
      : sessionRow.workspaceRoot || null;
  const out = {
    id: sessionRow.id.trim(),
    workspaceRoot,
    title: title.slice(0, 200),
    updatedAt: Number.isFinite(sessionRow.updatedAt) ? sessionRow.updatedAt : Date.now(),
    messages,
    tokenUsage: normalizeTokenUsageForStore(sessionRow.tokenUsage),
  };
  const modelPresetId = chatModelPresetIdForStore(sessionRow.modelPresetId);
  if (modelPresetId) out.modelPresetId = modelPresetId;
  const toolPermissionMode = chatToolPermissionModeForStore(sessionRow.toolPermissionMode);
  if (toolPermissionMode) out.toolPermissionMode = toolPermissionMode;
  return out;
}

function normalizeSessionForLoad(sessionRow) {
  if (!sessionRow || typeof sessionRow !== 'object') return null;
  const out = {
    id: sessionRow.id,
    workspaceRoot: sessionRow.workspaceRoot ?? null,
    title: typeof sessionRow.title === 'string' ? sessionRow.title : '',
    updatedAt: sessionRow.updatedAt,
    messages: normalizeLoadedMessages(sessionRow.messages),
    tokenUsage: normalizeTokenUsageForStore(sessionRow.tokenUsage),
  };
  const modelPresetId = chatModelPresetIdForStore(sessionRow.modelPresetId);
  if (modelPresetId) out.modelPresetId = modelPresetId;
  const toolPermissionMode = chatToolPermissionModeForStore(sessionRow.toolPermissionMode);
  if (toolPermissionMode) out.toolPermissionMode = toolPermissionMode;
  return out;
}

module.exports = {
  inferChatTitle,
  chatModelPresetIdForStore,
  chatToolPermissionModeForStore,
  toolTraceEntryToString,
  toolTraceEntryForStore,
  sanitizeChatMessagesForStore,
  storedChatMessagesChanged,
  normalizeTokenUsageForStore,
  normalizeLoadedMessages,
  normalizeSessionForStore,
  normalizeSessionForLoad,
};
