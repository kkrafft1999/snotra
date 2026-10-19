/**
 * Estimated API cost of a chat (#949).
 *
 * Pure functions only — the price table itself is loaded in main
 * (model-price-service.js), the sum per chat lives in the renderer and is
 * saved with the chat history. Both sides share this file, so a round priced
 * in main and a session summed in the renderer mean the same thing.
 *
 * Prices are **USD per token**, the unit of the source (LiteLLM's
 * `model_prices_and_context_window.json`). The settings show and take them
 * per million tokens; that conversion happens at the edge, not here.
 *
 * The figure is an estimate on purpose: no batch, priority or flex tiers, no
 * long-context surcharges, no regional pricing, USD only.
 */
'use strict';

const { APP_LOCALES } = require('./enums');
const { isRecord } = require('../runtime/is-record');
const { toUsageNumber, normalizeUsage } = require('./usage');

/**
 * USD per token (see above). Cache reads and writes without a price of their
 * own cost what input costs; reasoning is output unless the table names one.
 *
 * @typedef {Object} ModelPrice
 * @property {number} input
 * @property {number} output
 * @property {number} [cacheRead]
 * @property {number} [cacheWrite]
 * @property {number} [reasoning]
 */

/** @typedef {typeof PRICE_SOURCES[keyof typeof PRICE_SOURCES]} PriceSource */

/**
 * Tokens by the kinds a price distinguishes; `reasoning` is a part of `output`.
 *
 * @typedef {Object} CostTokens
 * @property {number} input
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} output
 * @property {number} reasoning
 */

/**
 * USD per token kind.
 *
 * @typedef {Object} CostUsd
 * @property {number} input
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} output
 */

/**
 * The cost of one provider and model: summed over its rounds, `usd` and
 * `priceSource` null while no round could be priced.
 *
 * @typedef {Object} CostEntry
 * @property {string} providerId
 * @property {string} model
 * @property {CostTokens} tokens
 * @property {CostUsd|null} usd
 * @property {PriceSource|null} priceSource
 * @property {number} rounds
 * @property {number} unpricedRounds
 */

/**
 * @typedef {Object} PriceTableInfo
 * @property {string} date  `YYYY-MM-DD`
 * @property {'downloaded'|'bundled'} origin
 */

/**
 * @typedef {Object} SessionCost
 * @property {number} version
 * @property {CostEntry[]} models
 * @property {PriceTableInfo} [priceTable]  the table the last round was priced with
 */

const SESSION_COST_VERSION = 1;

/**
 * The one place prices are fetched from, when the user asks for it
 * (*Settings › Models › Prices*) and when the bundled snapshot is renewed
 * (`scripts/update-model-prices.js`). Never contacted on its own.
 */
const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Where the price of a model came from. */
const PRICE_SOURCES = Object.freeze({
  TABLE: 'table',
  OVERRIDE: 'override',
  // A model running on the user's own machine: no API bill, priced at 0.
  LOCAL: 'local',
});

/**
 * The token kinds a price distinguishes, in display order.
 *
 * @type {readonly ('input'|'cacheRead'|'cacheWrite'|'output')[]}
 */
const COST_TOKEN_KINDS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output']);

const LITELLM_MODES = new Set(['chat', 'responses']);

/** @type {Array<keyof CostTokens>} */
const TOKEN_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];

/** @type {Array<'cacheRead'|'cacheWrite'|'reasoning'>} */
const OPTIONAL_PRICES = ['cacheRead', 'cacheWrite', 'reasoning'];
/**
 * A download with fewer models than this is not the price table, whatever
 * else it is — it never replaces the snapshot.
 */
const MIN_PRICE_TABLE_MODELS = 50;

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A model price `{ input, output, cacheRead?, cacheWrite?, reasoning? }` in
 * USD per token, or null when input or output is missing. Missing optional
 * prices fall back when a usage is priced, not here.
 *
 * @param {unknown} raw
 * @returns {ModelPrice|null}
 */
function normalizeModelPrice(raw) {
  if (!isRecord(raw)) return null;
  const input = toPrice(raw.input);
  const output = toPrice(raw.output);
  if (input === null || output === null) return null;
  /** @type {ModelPrice} */
  const price = { input, output };
  for (const key of OPTIONAL_PRICES) {
    const value = toPrice(raw[key]);
    if (value !== null) price[key] = value;
  }
  return price;
}

/**
 * Cuts LiteLLM's price file down to what the app needs: chat models of the
 * LiteLLM providers named — those the capability register lists under the
 * providers' `priceTable` trait (#996) —, five prices each, keys in lower
 * case. Returns `{ models }`, or null when the input does not look like that
 * file.
 *
 * @param {unknown} json
 * @param {Iterable<string>} litellmProviders
 */
function trimLiteLlmPrices(json, litellmProviders) {
  if (!isRecord(json) || Array.isArray(json)) return null;
  const keep = new Set(litellmProviders || []);
  /** @type {Record<string, ModelPrice>} */
  const models = {};
  for (const [key, entry] of Object.entries(json)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.litellm_provider !== 'string' || !keep.has(entry.litellm_provider)) continue;
    if (typeof entry.mode !== 'string' || !LITELLM_MODES.has(entry.mode)) continue;
    const price = normalizeModelPrice({
      input: entry.input_cost_per_token,
      output: entry.output_cost_per_token,
      cacheRead: entry.cache_read_input_token_cost,
      cacheWrite: entry.cache_creation_input_token_cost,
      reasoning: entry.output_cost_per_reasoning_token,
    });
    if (price) models[key.toLowerCase()] = price;
  }
  if (Object.keys(models).length < MIN_PRICE_TABLE_MODELS) return null;
  return { models };
}

const DATE_SUFFIX = /(?:-\d{4}-\d{2}-\d{2}|-\d{8}|@\d{8})$/;

/**
 * The keys a model may have in the price table, most specific first: the ID
 * as it is, with the provider's prefix, without a vendor prefix
 * (`anthropic/claude-…` on a router) and without a date suffix
 * (`gpt-x-2026-01-01` → `gpt-x`). `keyPrefixes` are the prefixes LiteLLM puts
 * in front of the provider's models — its `priceTable` trait (#996).
 *
 * @param {readonly string[]|undefined} keyPrefixes
 * @param {string|undefined} model
 */
function priceKeyCandidates(keyPrefixes, model) {
  const raw = typeof model === 'string' ? model.trim().toLowerCase().replace(/^models\//, '') : '';
  if (!raw) return [];
  const prefixes = Array.isArray(keyPrefixes) ? keyPrefixes : [];
  const bases = [raw];
  const slash = raw.lastIndexOf('/');
  if (slash >= 0 && slash < raw.length - 1) bases.push(raw.slice(slash + 1));
  for (const base of [...bases]) {
    const undated = base.replace(DATE_SUFFIX, '');
    if (undated && undated !== base) bases.push(undated);
  }
  /** @type {string[]} */
  const out = [];
  for (const base of bases) {
    out.push(base);
    for (const prefix of prefixes) out.push(prefix + base);
  }
  return [...new Set(out)];
}

/**
 * `{ key, price }` of the first candidate the table knows, or null.
 *
 * @param {Record<string, unknown>} models
 * @param {{ keyPrefixes?: readonly string[], model?: string }} [target]
 * @returns {{ key: string, price: ModelPrice }|null}
 */
function findModelPrice(models, { keyPrefixes, model } = {}) {
  if (!isRecord(models)) return null;
  for (const key of priceKeyCandidates(keyPrefixes, model)) {
    const price = normalizeModelPrice(models[key]);
    if (price) return { key, price };
  }
  return null;
}

/** @returns {CostTokens} */
function emptyTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

/**
 * Splits a normalised usage into the kinds a price distinguishes. `prompt`
 * contains the cache reads and writes (usage.js), so plain input is what is
 * left of it.
 *
 * @param {unknown} usage
 * @returns {CostTokens}
 */
function usageToCostTokens(usage) {
  const u = normalizeUsage(usage);
  if (!u) return emptyTokens();
  const cacheRead = toUsageNumber(u.cached);
  const cacheWrite = toUsageNumber(u.cacheWrite);
  return {
    input: Math.max(0, u.prompt - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: u.completion,
    reasoning: toUsageNumber(u.reasoning),
  };
}

/**
 * USD per token kind for these tokens at this price. Cache reads and writes
 * without a price of their own cost what input costs; reasoning is output,
 * unless the table names a reasoning price.
 *
 * @param {CostTokens} tokens
 * @param {unknown} rawPrice
 * @returns {CostUsd|null}
 */
function priceTokens(tokens, rawPrice) {
  const price = normalizeModelPrice(rawPrice);
  if (!price) return null;
  const reasoning = Math.min(tokens.reasoning, tokens.output);
  const output = price.reasoning === undefined
    ? tokens.output * price.output
    : (tokens.output - reasoning) * price.output + reasoning * price.reasoning;
  return {
    input: tokens.input * price.input,
    cacheRead: tokens.cacheRead * (price.cacheRead ?? price.input),
    cacheWrite: tokens.cacheWrite * (price.cacheWrite ?? price.input),
    output,
  };
}

/**
 * @param {CostUsd|null|undefined} usd
 * @returns {number|null}
 */
function sumUsd(usd) {
  if (!usd) return null;
  return COST_TOKEN_KINDS.reduce((sum, kind) => sum + (Number(usd[kind]) || 0), 0);
}

/**
 * @param {CostUsd|null} a
 * @param {CostUsd|null} b
 * @returns {CostUsd|null}
 */
function addUsd(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  /** @type {CostUsd} */
  const out = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const kind of COST_TOKEN_KINDS) out[kind] = (Number(a[kind]) || 0) + (Number(b[kind]) || 0);
  return out;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {CostTokens}
 */
function addTokens(a, b) {
  const out = emptyTokens();
  const field = (/** @type {unknown} */ tokens, /** @type {keyof CostTokens} */ key) => (isRecord(tokens) ? tokens[key] : undefined);
  for (const key of TOKEN_KEYS) out[key] = toUsageNumber(field(a, key)) + toUsageNumber(field(b, key));
  return out;
}

/**
 * The cost record of one model call. `price` is null when the model is
 * unknown — then `usd` is null too and the round counts as unpriced, never
 * as free.
 *
 * @param {{ providerId?: string, model?: string, usage?: object|null, price?: object|null, priceSource?: string|null }} [input]
 */
function createCostEntry({ providerId, model, usage, price = null, priceSource = null } = {}) {
  const tokens = usageToCostTokens(usage);
  const usd = priceSource === PRICE_SOURCES.LOCAL
    ? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    : priceTokens(tokens, price);
  return {
    providerId: typeof providerId === 'string' ? providerId : '',
    model: typeof model === 'string' ? model : '',
    tokens,
    usd,
    priceSource: usd ? priceSource : null,
    rounds: 1,
    unpricedRounds: usd ? 0 : 1,
  };
}

/**
 * @param {unknown} raw
 * @returns {CostEntry|null}
 */
function normalizeCostEntry(raw) {
  if (!isRecord(raw)) return null;
  const model = typeof raw.model === 'string' ? raw.model : '';
  const providerId = typeof raw.providerId === 'string' ? raw.providerId : '';
  if (!model && !providerId) return null;
  const tokens = addTokens(raw.tokens, null);
  /** @type {CostUsd | null} */
  let usd = null;
  if (isRecord(raw.usd)) {
    usd = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const kind of COST_TOKEN_KINDS) {
      const n = Number(raw.usd[kind]);
      usd[kind] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
  }
  const rounds = Math.max(1, toUsageNumber(raw.rounds));
  const priceSource = Object.values(PRICE_SOURCES).find((source) => source === raw.priceSource) ?? null;
  return {
    providerId,
    model,
    tokens,
    usd,
    priceSource: usd ? priceSource : null,
    rounds,
    unpricedRounds: Math.min(rounds, toUsageNumber(raw.unpricedRounds ?? (usd ? 0 : rounds))),
  };
}

/**
 * @param {unknown} raw
 * @returns {PriceTableInfo|null}
 */
function normalizePriceTableInfo(raw) {
  if (!isRecord(raw)) return null;
  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  if (!date) return null;
  return { date, origin: raw.origin === 'downloaded' ? 'downloaded' : 'bundled' };
}

/**
 * The cost of a chat as it is saved: one entry per provider and model, the
 * price table the last round was priced with. null when nothing was spent.
 *
 * @param {unknown} raw
 * @returns {SessionCost|null}
 */
function normalizeSessionCost(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.models)) return null;
  /** @type {CostEntry[]} */
  const models = [];
  for (const entry of raw.models) {
    const normalized = normalizeCostEntry(entry);
    if (normalized) models.push(normalized);
  }
  if (models.length === 0) return null;
  /** @type {SessionCost} */
  const cost = { version: SESSION_COST_VERSION, models };
  const priceTable = normalizePriceTableInfo(raw.priceTable);
  if (priceTable) cost.priceTable = priceTable;
  return cost;
}

/**
 * Adds the cost of a turn (`{ models, priceTable }`, as `chat:send` returns
 * it) to the cost of the chat so far. Entries of the same provider and model
 * are summed — a switch of model within the chat keeps both.
 *
 * @param {unknown} base
 * @param {unknown} addition
 * @returns {SessionCost|null}
 */
function mergeSessionCost(base, addition) {
  const current = normalizeSessionCost(base);
  const next = normalizeSessionCost(addition);
  if (!next) return current;
  if (!current) return next;
  const byKey = new Map(current.models.map((entry) => [`${entry.providerId}\u0000${entry.model}`, { ...entry }]));
  for (const entry of next.models) {
    const key = `${entry.providerId}\u0000${entry.model}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...entry });
      continue;
    }
    const usd = addUsd(prev.usd, entry.usd);
    byKey.set(key, {
      providerId: prev.providerId,
      model: prev.model,
      tokens: addTokens(prev.tokens, entry.tokens),
      usd,
      priceSource: entry.usd ? entry.priceSource : prev.priceSource,
      rounds: prev.rounds + entry.rounds,
      unpricedRounds: prev.unpricedRounds + entry.unpricedRounds,
    });
  }
  /** @type {SessionCost} */
  const merged = { version: SESSION_COST_VERSION, models: [...byKey.values()] };
  const priceTable = next.priceTable || current.priceTable;
  if (priceTable) merged.priceTable = priceTable;
  return merged;
}

/**
 * What the display needs: the sum in USD (null when no round could be
 * priced), whether every round was priced, the tokens over all models.
 *
 * @param {unknown} raw
 */
function summarizeSessionCost(raw) {
  const cost = normalizeSessionCost(raw);
  const tokens = emptyTokens();
  if (!cost) return { usd: null, complete: true, tokens, unpricedModels: [] };
  /** @type {number | null} */
  let usd = null;
  /** @type {string[]} */
  const unpricedModels = [];
  for (const entry of cost.models) {
    Object.assign(tokens, addTokens(tokens, entry.tokens));
    const entryUsd = sumUsd(entry.usd);
    if (entryUsd !== null) usd = (usd ?? 0) + entryUsd;
    if (entry.unpricedRounds > 0) unpricedModels.push(entry.model || entry.providerId);
  }
  return { usd, complete: unpricedModels.length === 0, tokens, unpricedModels };
}

/**
 * Total USD of one entry, null when none of its rounds was priced.
 *
 * @param {unknown} entry
 * @returns {number|null}
 */
function costEntryUsd(entry) {
  return sumUsd(normalizeCostEntry(entry)?.usd);
}

/**
 * USD for the display: two decimals, `<$0.01` style below a cent but above
 * nothing, and the dash — never 0 — for an unknown price. The currency sign
 * and its position follow the locale.
 *
 * @param {unknown} value
 * @param {string} [locale]
 */
function formatUsd(value, locale = APP_LOCALES.EN) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return '–';
  const format = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (n > 0 && n < 0.01) return `<${format.format(0.01)}`;
  return format.format(n);
}

module.exports = {
  SESSION_COST_VERSION,
  LITELLM_PRICES_URL,
  PRICE_SOURCES,
  COST_TOKEN_KINDS,
  MIN_PRICE_TABLE_MODELS,
  normalizeModelPrice,
  trimLiteLlmPrices,
  priceKeyCandidates,
  findModelPrice,
  usageToCostTokens,
  priceTokens,
  createCostEntry,
  normalizeCostEntry,
  normalizePriceTableInfo,
  normalizeSessionCost,
  mergeSessionCost,
  summarizeSessionCost,
  costEntryUsd,
  formatUsd,
};
