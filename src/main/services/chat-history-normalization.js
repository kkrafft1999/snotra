'use strict';

/**
 * Chat-Verlauf-Normalisierung (Stage 5).
 *
 * Single source of truth für Titel-Inferenz, Message-Sanitisierung,
 * Token-Usage und die vom Renderer konsumierte Loaded-Session-Form.
 */

function inferChatTitle(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const u = list.find((m) => m && m.role === 'user');
  if (u && u.content != null && String(u.content).trim()) {
    const t = String(u.content).trim().replace(/\s+/g, ' ');
    if (t.length > 48) return `${t.slice(0, 47)}…`;
    return t || 'Chat';
  }
  return 'Neuer Chat';
}

function messageContentForStore(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
    }
    if (parts.length) return parts.join('\n');
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
function toolTraceEntryForStore(entry) {
  const line = toolTraceEntryToString(entry);
  if (!line) return '';
  const tool = typeof entry?.tool === 'string' && entry.tool ? entry.tool : '';
  const skill = typeof entry?.skill === 'string' && entry.skill ? entry.skill : '';
  if (!tool && !skill) return line;
  const out = { line };
  if (tool) out.tool = tool;
  if (skill) out.skill = skill;
  if (entry?.activeSkill === true) out.activeSkill = true;
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
  if (message.role === 'user') return message.content.trim().length > 0;
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
      if (!content.trim()) continue;
      out.push({ role: 'user', content });
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
        return { role: 'user', content: messageContentForStore(m.content) };
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

function resolveSessionTitle(sessionRow, messages, existingTitle) {
  const titleRaw = typeof sessionRow.title === 'string' ? sessionRow.title.trim() : '';
  if (titleRaw) return titleRaw;
  const preserved = typeof existingTitle === 'string' ? existingTitle.trim() : '';
  if (preserved) return preserved;
  return inferChatTitle(messages);
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
  return {
    id: sessionRow.id.trim(),
    workspaceRoot,
    title: title ? title.slice(0, 200) : 'Chat',
    updatedAt: Number.isFinite(sessionRow.updatedAt) ? sessionRow.updatedAt : Date.now(),
    messages,
    tokenUsage: normalizeTokenUsageForStore(sessionRow.tokenUsage),
  };
}

function normalizeSessionForLoad(sessionRow) {
  if (!sessionRow || typeof sessionRow !== 'object') return null;
  return {
    id: sessionRow.id,
    workspaceRoot: sessionRow.workspaceRoot ?? null,
    title: sessionRow.title || 'Chat',
    updatedAt: sessionRow.updatedAt,
    messages: normalizeLoadedMessages(sessionRow.messages),
    tokenUsage: normalizeTokenUsageForStore(sessionRow.tokenUsage),
  };
}

module.exports = {
  inferChatTitle,
  toolTraceEntryToString,
  toolTraceEntryForStore,
  sanitizeChatMessagesForStore,
  normalizeTokenUsageForStore,
  normalizeLoadedMessages,
  normalizeSessionForStore,
  normalizeSessionForLoad,
};
