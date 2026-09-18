/**
 * Token-Usage-Contract (Roadmap-Etappe 1).
 *
 * Einzige Quelle der Wahrheit für die Normalisierung und Summierung der
 * provider-spezifischen Usage-Zahlen. Vorher lag diese Logik doppelt vor
 * (src/main/providers/stream-helpers.js und die Renderer-Anzeige in
 * ChatStream.js); beide beziehen sie jetzt von hier.
 */
'use strict';

function toUsageNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function createEmptyUsage() {
  return { prompt: 0, completion: 0, total: 0, cached: 0 };
}

/**
 * Aus dem Prompt-Cache gelesene Token (Issue #179).
 *
 * Das Auslesen ist der kleinere Teil — die Anbieter meinen mit ihren Zahlen
 * Verschiedenes:
 *  - **OpenAI** legt `cached_tokens` in `input_tokens_details` (Responses) bzw.
 *    `prompt_tokens_details` (Chat Completions) ab. Es ist eine **Teilmenge**
 *    von `input_tokens`/`prompt_tokens`.
 *  - **Anthropic** stellt `cache_read_input_tokens` und
 *    `cache_creation_input_tokens` **neben** `input_tokens`. Der volle Prompt
 *    ist dort die Summe aus allen dreien.
 *  - **Google** meldet `cachedContentTokenCount`, wieder als Teilmenge von
 *    `promptTokenCount`.
 * Wer das naiv addiert, zaehlt bei OpenAI doppelt; wer es naiv stehen laesst,
 * verliert bei Anthropic den groessten Teil des Prompts.
 *
 * Normalisiert wird deshalb auf eine Bedeutung, die bei jedem Anbieter
 * dieselbe ist: `prompt` ist der **ganze** Prompt dieser Runde, `cached` der
 * davon aus dem Cache gelesene Teil. Damit gilt immer `cached <= prompt`, und
 * die Anzeige braucht den Anbieter nicht zu kennen.
 */
function readCachedPromptTokens(raw) {
  return toUsageNumber(
    raw.cached
    ?? raw.cached_tokens
    ?? raw.input_tokens_details?.cached_tokens
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.cache_read_input_tokens
    ?? raw.cachedContentTokenCount
  );
}

/**
 * Anteile, die Anthropic **neben** `input_tokens` fuehrt und die deshalb zum
 * Prompt addiert werden muessen. Die Schluessel gibt es nur dort; bei allen
 * anderen Anbietern (und bei einem bereits normalisierten Objekt) ist das 0.
 */
function readSeparateCacheTokens(raw) {
  return (
    toUsageNumber(raw.cache_read_input_tokens) + toUsageNumber(raw.cache_creation_input_tokens)
  );
}

/**
 * Normalisiert eine provider-spezifische Usage-Struktur auf
 * { prompt, completion, total, cached }. Liefert null, wenn keine Zahlen
 * vorhanden sind (so kann der Aufrufer "keine Usage" von "0 Tokens"
 * unterscheiden).
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt =
    toUsageNumber(
      raw.prompt
      ?? raw.input
      ?? raw.input_tokens
      ?? raw.prompt_tokens
      ?? raw.promptTokenCount
      ?? raw.prompt_eval_count
    ) + readSeparateCacheTokens(raw);
  const completion = toUsageNumber(
    raw.completion
    ?? raw.output
    ?? raw.output_tokens
    ?? raw.completion_tokens
    ?? raw.candidatesTokenCount
    ?? raw.eval_count
  );
  // Nie mehr aus dem Cache als ueberhaupt im Prompt: Eine Zahl, die das
  // verletzt, ist falsch gelesen — dann lieber deckeln als eine Anzeige mit
  // „112 % aus dem Cache".
  const cached = Math.min(readCachedPromptTokens(raw), prompt);
  let total = toUsageNumber(raw.total ?? raw.total_tokens ?? raw.totalTokenCount);
  if (total === 0 && (prompt > 0 || completion > 0)) {
    total = prompt + completion;
  }
  if (prompt === 0 && completion === 0 && total === 0) return null;
  return { prompt, completion, total, cached };
}

/**
 * Wie normalizeUsage, liefert aber immer ein Objekt ({0,0,0} statt null) —
 * praktisch für die Anzeige, die keinen Nullwert darstellen muss.
 */
function coerceUsage(raw) {
  return normalizeUsage(raw) || createEmptyUsage();
}

/** Summiert zwei Usage-Objekte runden-übergreifend. */
function mergeUsage(base, addition) {
  const next = normalizeUsage(addition);
  if (!next) return base ? { ...base } : null;
  if (!base) return next;
  const prompt = base.prompt + next.prompt;
  const completion = base.completion + next.completion;
  const total = base.total + (next.total > 0 ? next.total : next.prompt + next.completion);
  const cached = toUsageNumber(base.cached) + next.cached;
  return { prompt, completion, total, cached };
}

module.exports = {
  toUsageNumber,
  createEmptyUsage,
  normalizeUsage,
  coerceUsage,
  mergeUsage,
};
