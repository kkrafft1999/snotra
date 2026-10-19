/**
 * Token-Usage-Contract (Roadmap-Etappe 1).
 *
 * Einzige Quelle der Wahrheit für die Normalisierung und Summierung der
 * provider-spezifischen Usage-Zahlen. Vorher lag diese Logik doppelt vor
 * (src/main/providers/stream-helpers.js und die Renderer-Anzeige in
 * ChatStream.js); beide beziehen sie jetzt von hier.
 */
'use strict';

const { isRecord } = require('../runtime/is-record');

/**
 * What one provider reported, in that provider's own field names — OpenAI,
 * Anthropic, Google and Ollama each spell it differently, and a usage that
 * was normalized before comes back through here as well.
 *
 * @typedef {Record<string, any>} RawUsage  // any: provider JSON, read field by field below
 */

/**
 * Tokens of one round or, summed, of a turn. `cached` is the part of `prompt`
 * read from the cache; `cacheWrite` and `reasoning` are left out at 0.
 *
 * @typedef {Object} Usage
 * @property {number} prompt
 * @property {number} completion
 * @property {number} total
 * @property {number} cached
 * @property {number} [cacheWrite]
 * @property {number} [reasoning]
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
function toUsageNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** @returns {Usage} */
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
 *
 * @param {RawUsage} raw
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
 *
 * @param {RawUsage} raw
 */
function readSeparateCacheTokens(raw) {
  return (
    toUsageNumber(raw.cache_read_input_tokens) + toUsageNumber(raw.cache_creation_input_tokens)
  );
}

/**
 * Tokens written to the prompt cache in this round (#949). Only Anthropic
 * reports them, next to `input_tokens`; they are part of `prompt` already
 * (readSeparateCacheTokens) and are priced differently from plain input.
 *
 * @param {RawUsage} raw
 */
function readCacheWriteTokens(raw) {
  return toUsageNumber(raw.cacheWrite ?? raw.cache_creation_input_tokens);
}

/**
 * Reasoning tokens of this round (#949), always meant as a **part** of
 * `completion`. OpenAI counts them into the output already
 * (`output_tokens_details` / `completion_tokens_details`); Google reports
 * `thoughtsTokenCount` **next to** `candidatesTokenCount` instead, so there
 * they are added to `completion` — see readSeparateReasoningTokens.
 *
 * @param {RawUsage} raw
 */
function readReasoningTokens(raw) {
  return toUsageNumber(
    raw.reasoning
    ?? raw.output_tokens_details?.reasoning_tokens
    ?? raw.completion_tokens_details?.reasoning_tokens
    ?? raw.thoughtsTokenCount
  );
}

/**
 * Google's thinking, billed as output but not counted in it (#949).
 *
 * @param {RawUsage} raw
 */
function readSeparateReasoningTokens(raw) {
  return toUsageNumber(raw.thoughtsTokenCount);
}

/**
 * Normalisiert eine provider-spezifische Usage-Struktur auf
 * { prompt, completion, total, cached }, plus `cacheWrite` and `reasoning`
 * when the provider reported any (#949). The two extra fields are left out
 * at 0, so the shape the token display knows stays the same. Liefert null, wenn keine Zahlen
 * vorhanden sind (so kann der Aufrufer "keine Usage" von "0 Tokens"
 * unterscheiden).
 *
 * @param {unknown} raw
 * @returns {Usage|null}
 */
function normalizeUsage(raw) {
  if (!isRecord(raw)) return null;
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
  ) + readSeparateReasoningTokens(raw);
  // Nie mehr aus dem Cache als ueberhaupt im Prompt: Eine Zahl, die das
  // verletzt, ist falsch gelesen — dann lieber deckeln als eine Anzeige mit
  // „112 % aus dem Cache".
  const cached = Math.min(readCachedPromptTokens(raw), prompt);
  let total = toUsageNumber(raw.total ?? raw.total_tokens ?? raw.totalTokenCount);
  if (total === 0 && (prompt > 0 || completion > 0)) {
    total = prompt + completion;
  }
  if (prompt === 0 && completion === 0 && total === 0) return null;
  /** @type {Usage} */
  const usage = { prompt, completion, total, cached };
  // Same guard as for `cached`: a part never outgrows the whole.
  const cacheWrite = Math.min(readCacheWriteTokens(raw), prompt - cached);
  const reasoning = Math.min(readReasoningTokens(raw), completion);
  if (cacheWrite > 0) usage.cacheWrite = cacheWrite;
  if (reasoning > 0) usage.reasoning = reasoning;
  return usage;
}

/**
 * Wie normalizeUsage, liefert aber immer ein Objekt ({0,0,0} statt null) —
 * praktisch für die Anzeige, die keinen Nullwert darstellen muss.
 *
 * @param {unknown} raw
 * @returns {Usage}
 */
function coerceUsage(raw) {
  return normalizeUsage(raw) || createEmptyUsage();
}

/**
 * Summiert zwei Usage-Objekte runden-übergreifend.
 *
 * @param {Usage|null|undefined} base
 * @param {unknown} addition
 * @returns {Usage|null}
 */
function mergeUsage(base, addition) {
  const next = normalizeUsage(addition);
  if (!next) return base ? { ...base } : null;
  if (!base) return next;
  const prompt = base.prompt + next.prompt;
  const completion = base.completion + next.completion;
  const total = base.total + (next.total > 0 ? next.total : next.prompt + next.completion);
  const cached = toUsageNumber(base.cached) + next.cached;
  /** @type {Usage} */
  const merged = { prompt, completion, total, cached };
  const cacheWrite = toUsageNumber(base.cacheWrite) + toUsageNumber(next.cacheWrite);
  const reasoning = toUsageNumber(base.reasoning) + toUsageNumber(next.reasoning);
  if (cacheWrite > 0) merged.cacheWrite = cacheWrite;
  if (reasoning > 0) merged.reasoning = reasoning;
  return merged;
}

module.exports = {
  toUsageNumber,
  createEmptyUsage,
  normalizeUsage,
  coerceUsage,
  mergeUsage,
};
