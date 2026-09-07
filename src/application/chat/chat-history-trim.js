// Begrenzt, wie viel Verlauf pro Chat-Request an den Provider geht.
// Heuristik statt echter Tokenizer: 1 Token ≈ 4 Zeichen; das Budget wird
// deshalb in Zeichen gefuehrt und ist ueber ui-preferences.json
// (historyCharLimit) konfigurierbar.

const { attachmentsCharCost } = require('../../shared/contracts/attachments');

const CHARS_PER_TOKEN = 4;
const HISTORY_CHAR_LIMIT_MIN = 4000;
const HISTORY_CHAR_LIMIT_MAX = 2_000_000;
const DEFAULT_HISTORY_CHAR_LIMIT = 200_000;

const TOOL_OUTPUT_PLACEHOLDER = JSON.stringify({
  note: 'Ältere Tool-Ausgabe wurde gekürzt, um den Verlauf kompakt zu halten.',
});

function clampHistoryCharLimit(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(HISTORY_CHAR_LIMIT_MAX, Math.max(HISTORY_CHAR_LIMIT_MIN, Math.round(raw)));
}

function resolveHistoryCharLimit(uiPrefs) {
  return clampHistoryCharLimit(uiPrefs?.historyCharLimit) ?? DEFAULT_HISTORY_CHAR_LIMIT;
}

function estimateMessageChars(message) {
  if (!message || typeof message !== 'object') return 0;
  let chars = 24; // Rolle + Struktur-Overhead
  if (typeof message.content === 'string') {
    chars += message.content.length;
  } else if (message.content != null) {
    try {
      chars += JSON.stringify(message.content).length;
    } catch {
      /* zirkulaer o. ae. — Overhead reicht */
    }
  }
  // Bild-Anhaenge (Issue #84) stehen nicht im Content, kosten den Anbieter
  // aber Tokens — ohne diesen Posten fensterte der Verlauf sie als gratis.
  chars += attachmentsCharCost(message);
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      chars += 24;
      chars += tc?.function?.name?.length || 0;
      if (typeof tc?.function?.arguments === 'string') chars += tc.function.arguments.length;
    }
  }
  return chars;
}

function estimateMessagesChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) total += estimateMessageChars(m);
  return total;
}

function estimateTokens(messages) {
  return Math.ceil(estimateMessagesChars(messages) / CHARS_PER_TOKEN);
}

/**
 * Fenstert den vom Renderer uebergebenen Verlauf (nur user/assistant-Texte):
 * von der neuesten Nachricht rueckwaerts, bis das Budget erschoepft ist.
 * Die letzte Nachricht (die aktuelle User-Frage) bleibt immer erhalten.
 */
function trimHistoryMessages(messages, charLimit = DEFAULT_HISTORY_CHAR_LIMIT) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], dropped: 0 };
  }
  const kept = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = estimateMessageChars(messages[i]);
    if (kept.length > 0 && used + cost > charLimit) break;
    kept.unshift(messages[i]);
    used += cost;
  }
  return { messages: kept, dropped: messages.length - kept.length };
}

/**
 * Kuerzt innerhalb eines laufenden Requests die Tool-Ausgaben frueherer
 * Runden auf einen Platzhalter, sobald das Budget ueberschritten ist.
 * Die Ausgaben der juengsten Runde (nach der letzten Assistant-Nachricht)
 * bleiben unangetastet, ebenso alle user/assistant-Nachrichten — die
 * Nachrichtenstruktur (tool_call_id-Paarung) bleibt API-gueltig.
 */
function truncateStaleToolOutputs(apiMessages, charLimit = DEFAULT_HISTORY_CHAR_LIMIT) {
  if (!Array.isArray(apiMessages)) return 0;
  let total = estimateMessagesChars(apiMessages);
  if (total <= charLimit) return 0;

  let lastAssistantIdx = -1;
  for (let i = apiMessages.length - 1; i >= 0; i -= 1) {
    if (apiMessages[i]?.role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  let truncated = 0;
  for (let i = 0; i < apiMessages.length && total > charLimit; i += 1) {
    const m = apiMessages[i];
    if (m?.role !== 'tool' || i > lastAssistantIdx) continue;
    if (typeof m.content !== 'string' || m.content.length <= TOOL_OUTPUT_PLACEHOLDER.length) {
      continue;
    }
    total -= m.content.length - TOOL_OUTPUT_PLACEHOLDER.length;
    m.content = TOOL_OUTPUT_PLACEHOLDER;
    truncated += 1;
  }
  return truncated;
}

module.exports = {
  CHARS_PER_TOKEN,
  DEFAULT_HISTORY_CHAR_LIMIT,
  HISTORY_CHAR_LIMIT_MIN,
  HISTORY_CHAR_LIMIT_MAX,
  TOOL_OUTPUT_PLACEHOLDER,
  clampHistoryCharLimit,
  resolveHistoryCharLimit,
  estimateMessageChars,
  estimateMessagesChars,
  estimateTokens,
  trimHistoryMessages,
  truncateStaleToolOutputs,
};
