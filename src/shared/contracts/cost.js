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

const { toUsageNumber, normalizeUsage } = require('./usage');

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

/** The token kinds a price distinguishes, in display order. */
const COST_TOKEN_KINDS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output']);

/** LiteLLM providers the snapshot keeps — the ones Snotra talks to. */
const LITELLM_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'openrouter']);
const LITELLM_MODES = new Set(['chat', 'responses']);
/**
 * A download with fewer models than this is not the price table, whatever
 * else it is — it never replaces the snapshot.
 */
const MIN_PRICE_TABLE_MODELS = 50;

/** Model-ID prefixes LiteLLM puts in front of a provider's models. */
const PROVIDER_KEY_PREFIXES = Object.freeze({
  google: ['gemini/'],
  'openai-compatible': ['openrouter/'],
});

function toPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A model price `{ input, output, cacheRead?, cacheWrite?, reasoning? }` in
 * USD per token, or null when input or output is missing. Missing optional
 * prices fall back when a usage is priced, not here.
 */
function normalizeModelPrice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = toPrice(raw.input);
  const output = toPrice(raw.output);
  if (input === null || output === null) return null;
  const price = { input, output };
  for (const key of ['cacheRead', 'cacheWrite', 'reasoning']) {
    const value = toPrice(raw[key]);
    if (value !== null) price[key] = value;
  }
  return price;
}

/**
 * Cuts LiteLLM's price file down to what the app needs: chat models of the
 * providers above, five prices each, keys in lower case. Returns
 * `{ models }`, or null when the input does not look like that file.
 */
function trimLiteLlmPrices(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const models = {};
  for (const [key, entry] of Object.entries(json)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!LITELLM_PROVIDERS.has(entry.litellm_provider)) continue;
    if (!LITELLM_MODES.has(entry.mode)) continue;
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
 * (`gpt-x-2026-01-01` → `gpt-x`).
 */
function priceKeyCandidates(providerId, model) {
  const raw = typeof model === 'string' ? model.trim().toLowerCase().replace(/^models\//, '') : '';
  if (!raw) return [];
  const prefixes = PROVIDER_KEY_PREFIXES[providerId] || [];
  const bases = [raw];
  const slash = raw.lastIndexOf('/');
  if (slash >= 0 && slash < raw.length - 1) bases.push(raw.slice(slash + 1));
  for (const base of [...bases]) {
    const undated = base.replace(DATE_SUFFIX, '');
    if (undated && undated !== base) bases.push(undated);
  }
  const out = [];
  for (const base of bases) {
    out.push(base);
    for (const prefix of prefixes) out.push(prefix + base);
  }
  return [...new Set(out)];
}

/** `{ key, price }` of the first candidate the table knows, or null. */
function findModelPrice(models, { providerId, model } = {}) {
  if (!models || typeof models !== 'object') return null;
  for (const key of priceKeyCandidates(providerId, model)) {
    const price = normalizeModelPrice(models[key]);
    if (price) return { key, price };
  }
  return null;
}

function emptyTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

/**
 * Splits a normalised usage into the kinds a price distinguishes. `prompt`
 * contains the cache reads and writes (usage.js), so plain input is what is
 * left of it.
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

function sumUsd(usd) {
  if (!usd) return null;
  return COST_TOKEN_KINDS.reduce((sum, kind) => sum + (Number(usd[kind]) || 0), 0);
}

function addUsd(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const out = {};
  for (const kind of COST_TOKEN_KINDS) out[kind] = (Number(a[kind]) || 0) + (Number(b[kind]) || 0);
  return out;
}

function addTokens(a, b) {
  const out = emptyTokens();
  for (const key of Object.keys(out)) out[key] = toUsageNumber(a?.[key]) + toUsageNumber(b?.[key]);
  return out;
}

/**
 * The cost record of one model call. `price` is null when the model is
 * unknown — then `usd` is null too and the round counts as unpriced, never
 * as free.
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

function normalizeCostEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = typeof raw.model === 'string' ? raw.model : '';
  const providerId = typeof raw.providerId === 'string' ? raw.providerId : '';
  if (!model && !providerId) return null;
  const tokens = addTokens(raw.tokens, null);
  let usd = null;
  if (raw.usd && typeof raw.usd === 'object') {
    usd = {};
    for (const kind of COST_TOKEN_KINDS) {
      const n = Number(raw.usd[kind]);
      usd[kind] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
  }
  const rounds = Math.max(1, toUsageNumber(raw.rounds));
  const priceSource = Object.values(PRICE_SOURCES).includes(raw.priceSource) ? raw.priceSource : null;
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

function normalizePriceTableInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  if (!date) return null;
  return { date, origin: raw.origin === 'downloaded' ? 'downloaded' : 'bundled' };
}

/**
 * The cost of a chat as it is saved: one entry per provider and model, the
 * price table the last round was priced with. null when nothing was spent.
 */
function normalizeSessionCost(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models)) return null;
  const models = raw.models.map(normalizeCostEntry).filter(Boolean);
  if (models.length === 0) return null;
  const cost = { version: SESSION_COST_VERSION, models };
  const priceTable = normalizePriceTableInfo(raw.priceTable);
  if (priceTable) cost.priceTable = priceTable;
  return cost;
}

/**
 * Adds the cost of a turn (`{ models, priceTable }`, as `chat:send` returns
 * it) to the cost of the chat so far. Entries of the same provider and model
 * are summed — a switch of model within the chat keeps both.
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
  const merged = { version: SESSION_COST_VERSION, models: [...byKey.values()] };
  const priceTable = next.priceTable || current.priceTable;
  if (priceTable) merged.priceTable = priceTable;
  return merged;
}

/**
 * What the display needs: the sum in USD (null when no round could be
 * priced), whether every round was priced, the tokens over all models.
 */
function summarizeSessionCost(raw) {
  const cost = normalizeSessionCost(raw);
  const tokens = emptyTokens();
  if (!cost) return { usd: null, complete: true, tokens, unpricedModels: [] };
  let usd = null;
  const unpricedModels = [];
  for (const entry of cost.models) {
    Object.assign(tokens, addTokens(tokens, entry.tokens));
    const entryUsd = sumUsd(entry.usd);
    if (entryUsd !== null) usd = (usd ?? 0) + entryUsd;
    if (entry.unpricedRounds > 0) unpricedModels.push(entry.model || entry.providerId);
  }
  return { usd, complete: unpricedModels.length === 0, tokens, unpricedModels };
}

/** Total USD of one entry, null when none of its rounds was priced. */
function costEntryUsd(entry) {
  return sumUsd(normalizeCostEntry(entry)?.usd);
}

/**
 * USD for the display: two decimals, `<$0.01` style below a cent but above
 * nothing, and the dash — never 0 — for an unknown price. The currency sign
 * and its position follow the locale.
 */
function formatUsd(value, locale = 'en') {
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
