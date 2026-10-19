/**
 * Model prices for the estimated chat cost (#949).
 *
 * Four layers, the first one that knows a model wins:
 *   1. the user's override for that model (*Settings › Models › Prices*) —
 *      it also prices a local proxy that forwards to a paid API,
 *   2. a model on the user's own machine (Ollama, a server at a loopback
 *      address): 0, there is no API bill,
 *   3. the price table — a download the user asked for, else the snapshot
 *      bundled with the release (src/main/data/model-prices.json),
 *   4. nothing: the round stays unpriced and shows as `–`, never as 0.
 *
 * The service never goes online by itself; only updateTable() does, and only
 * when the user presses the button (README: "Nothing phones home").
 */
'use strict';

const {
  LITELLM_PRICES_URL,
  PRICE_SOURCES,
  findModelPrice,
  normalizeModelPrice,
  trimLiteLlmPrices,
} = require('../../shared/contracts/cost');
const { writeFileAtomic } = require('./atomic-write');
const { declaredProviderTraits } = require('../../shared/contracts/provider-capabilities');
const { isRecord } = require('../../shared/runtime/is-record');

/** @typedef {import('../../shared/contracts/cost').ModelPrice} ModelPrice */
/** @typedef {import('../../shared/contracts/cost').PriceSource} PriceSource */

/**
 * A price table as it is kept: the day it was made, and the prices by model key.
 * @typedef {{ date: string, models: Record<string, unknown> }} StoredTable
 *
 * What the service holds once the file is read.
 * @typedef {{ overrides: Record<string, ModelPrice>, downloaded: StoredTable | null }} PriceState
 */

const PRICES_FILENAME = 'model-prices.json';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

const UPDATE_ERROR_CODES = Object.freeze({
  NETWORK: 'network',
  INVALID: 'invalid',
  WRITE: 'write',
});

/** @param {unknown} baseUrl */
function isLoopbackUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false;
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** @param {unknown} model */
function modelKey(model) {
  return typeof model === 'string' ? model.trim().toLowerCase() : '';
}

/**
 * @param {unknown} raw
 * @returns {Record<string, ModelPrice>}
 */
function normalizeOverrides(raw) {
  /** @type {Record<string, ModelPrice>} */
  const out = {};
  if (!isRecord(raw)) return out;
  for (const [model, price] of Object.entries(raw)) {
    const key = modelKey(model);
    const normalized = normalizeModelPrice(price);
    if (key && normalized) out[key] = normalized;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {StoredTable | null}
 */
function normalizeStoredTable(raw) {
  if (!isRecord(raw)) return null;
  if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
  if (!isRecord(raw.models)) return null;
  return { date: raw.date, models: raw.models };
}

/**
 * @param {Object} deps
 * @param {Pick<typeof import('fs/promises'), 'readFile' | 'open' | 'unlink' | 'rename'>} deps.fs
 *   the promise API (`fs/promises`), as the other stores take it
 * @param {typeof import('path')} deps.path
 * @param {string} deps.userDataPath
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {{ date?: string, models?: Record<string, unknown> }} [deps.snapshot]  the table bundled with the release
 * @param {Pick<typeof import('../providers'), 'getProvider' | 'litellmPriceProviders'>} [deps.providers]
 * @param {() => Date} [deps.now]
 * @param {{ warn?: (...args: unknown[]) => void }} [deps.log]
 */
function createModelPriceService({
  fs,
  path,
  userDataPath,
  fetchImpl = (url, init) => fetch(url, init),
  snapshot = require('../data/model-prices.json'),
  // The capability register (#996): which models run locally, which LiteLLM
  // providers and key prefixes a provider's prices are under.
  providers = require('../providers'),
  now = () => new Date(),
  log = console,
}) {
  const filePath = () => path.join(userDataPath, PRICES_FILENAME);
  /** @param {unknown} providerId */
  const traitsOf = (providerId) => declaredProviderTraits(providers.getProvider(providerId));
  /** @type {PriceState} */
  let state = { overrides: {}, downloaded: null };
  let loaded = false;
  /** @type {Promise<void>} */
  let writing = Promise.resolve();

  async function load() {
    if (loaded) return state;
    /** @type {Record<string, unknown>} */
    let stored = {};
    try {
      stored = JSON.parse(await fs.readFile(filePath(), 'utf8')) || {};
    } catch (err) {
      if (err?.code !== 'ENOENT') log.warn?.('[model-prices] could not read the stored prices:', err?.message);
    }
    state = {
      overrides: normalizeOverrides(stored.overrides),
      downloaded: normalizeStoredTable(stored.table),
    };
    loaded = true;
    return state;
  }

  async function persist() {
    /** @type {{ overrides: Record<string, ModelPrice>, table?: StoredTable }} */
    const data = { overrides: state.overrides };
    if (state.downloaded) data.table = state.downloaded;
    const target = filePath();
    writing = writing.catch(() => {}).then(() => writeFileAtomic(fs, target, `${JSON.stringify(data)}\n`, { mode: 0o600 }));
    return writing;
  }

  function activeTable() {
    // A download older than the snapshot of a newer release loses to it.
    const downloaded = state.downloaded;
    if (downloaded && (!snapshot?.date || downloaded.date >= snapshot.date)) {
      return { date: downloaded.date, origin: 'downloaded', models: downloaded.models };
    }
    return { date: snapshot?.date || null, origin: 'bundled', models: snapshot?.models || {} };
  }

  /** Date and origin of the table in use — shown under every estimate. */
  async function tableInfo() {
    await load();
    const table = activeTable();
    return table.date ? { date: table.date, origin: table.origin } : null;
  }

  /**
   * The price of one model. `{ price, priceSource }`; both null when nothing
   * is known about it.
   *
   * @param {{ providerId?: string, model?: string, baseUrl?: string }} [query]
   * @returns {Promise<{ price: ModelPrice|null, priceSource: PriceSource|null }>}
   */
  async function resolve({ providerId, model, baseUrl } = {}) {
    await load();
    const override = state.overrides[modelKey(model)];
    if (override) return { price: override, priceSource: PRICE_SOURCES.OVERRIDE };
    const traits = traitsOf(providerId);
    if (traits.runsLocally || isLoopbackUrl(baseUrl)) {
      return { price: null, priceSource: PRICE_SOURCES.LOCAL };
    }
    const found = findModelPrice(activeTable().models, { keyPrefixes: traits.priceTable.keyPrefixes, model });
    if (found) return { price: found.price, priceSource: PRICE_SOURCES.TABLE };
    return { price: null, priceSource: null };
  }

  /**
   * What the settings show for these models: price, source, override.
   * @param {Array<{ providerId?: unknown, model?: unknown, baseUrl?: string }>} [models]
   */
  async function describe(models = []) {
    await load();
    const table = activeTable();
    /** @type {Array<{ providerId: string, model: string, priceSource: PriceSource|null, price: ModelPrice|null, tablePrice: ModelPrice|null, override: ModelPrice|null }>} */
    const rows = [];
    for (const entry of Array.isArray(models) ? models : []) {
      const model = typeof entry?.model === 'string' ? entry.model : '';
      if (!model) continue;
      const providerId = typeof entry.providerId === 'string' ? entry.providerId : '';
      const resolved = await resolve({ providerId, model, baseUrl: entry.baseUrl });
      const tablePrice = findModelPrice(table.models, {
        keyPrefixes: traitsOf(providerId).priceTable.keyPrefixes,
        model,
      });
      rows.push({
        providerId,
        model,
        priceSource: resolved.priceSource,
        price: resolved.price,
        tablePrice: tablePrice ? tablePrice.price : null,
        override: state.overrides[modelKey(model)] || null,
      });
    }
    return {
      table: { date: table.date, origin: table.origin, modelCount: Object.keys(table.models).length },
      models: rows,
    };
  }

  /**
   * Sets (price) or clears (null) the override of one model.
   * @param {unknown} model
   * @param {unknown} price
   */
  async function setOverride(model, price) {
    await load();
    const key = modelKey(model);
    if (!key) return { ok: false };
    const normalized = price === null ? null : normalizeModelPrice(price);
    if (price !== null && !normalized) return { ok: false };
    if (normalized) state.overrides[key] = normalized;
    else delete state.overrides[key];
    await persist();
    return { ok: true };
  }

  /**
   * Fetches LiteLLM's table, checks it and keeps it. On any error the table
   * in use stays as it was, and the caller learns why.
   */
  async function updateTable() {
    await load();
    let json;
    try {
      const res = await fetchImpl(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) return { ok: false, code: UPDATE_ERROR_CODES.NETWORK, status: res.status };
      json = await res.json();
    } catch (err) {
      const code = err instanceof SyntaxError ? UPDATE_ERROR_CODES.INVALID : UPDATE_ERROR_CODES.NETWORK;
      return { ok: false, code };
    }
    const trimmed = trimLiteLlmPrices(json, providers.litellmPriceProviders());
    if (!trimmed) return { ok: false, code: UPDATE_ERROR_CODES.INVALID };
    const previous = state.downloaded;
    state.downloaded = { date: now().toISOString().slice(0, 10), models: trimmed.models };
    try {
      await persist();
    } catch {
      state.downloaded = previous;
      return { ok: false, code: UPDATE_ERROR_CODES.WRITE };
    }
    return { ok: true, date: state.downloaded.date, modelCount: Object.keys(trimmed.models).length };
  }

  return { resolve, tableInfo, describe, setOverride, updateTable };
}

module.exports = {
  createModelPriceService,
  isLoopbackUrl,
  UPDATE_ERROR_CODES,
  PRICES_FILENAME,
};
