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

const PRICES_FILENAME = 'model-prices.json';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** Providers whose models always run on this machine. */
const LOCAL_PROVIDERS = new Set(['ollama']);

const UPDATE_ERROR_CODES = Object.freeze({
  NETWORK: 'network',
  INVALID: 'invalid',
  WRITE: 'write',
});

function isLoopbackUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false;
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

function modelKey(model) {
  return typeof model === 'string' ? model.trim().toLowerCase() : '';
}

function normalizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [model, price] of Object.entries(raw)) {
    const key = modelKey(model);
    const normalized = normalizeModelPrice(price);
    if (key && normalized) out[key] = normalized;
  }
  return out;
}

function normalizeStoredTable(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
  if (!raw.models || typeof raw.models !== 'object') return null;
  return { date: raw.date, models: raw.models };
}

function createModelPriceService({
  // The promise API (`fs/promises`), as the other stores take it.
  fs,
  path,
  app,
  fetchImpl = (...args) => fetch(...args),
  snapshot = require('../data/model-prices.json'),
  now = () => new Date(),
  log = console,
}) {
  const filePath = () => path.join(app.getPath('userData'), PRICES_FILENAME);
  let state = null;
  let writing = Promise.resolve();

  async function load() {
    if (state) return state;
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
    return state;
  }

  async function persist() {
    const data = { overrides: state.overrides };
    if (state.downloaded) data.table = state.downloaded;
    const target = filePath();
    writing = writing.catch(() => {}).then(() => writeFileAtomic(fs, target, `${JSON.stringify(data)}\n`, { mode: 0o600 }));
    return writing;
  }

  function activeTable() {
    // A download older than the snapshot of a newer release loses to it.
    const downloaded = state?.downloaded;
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
   */
  async function resolve({ providerId, model, baseUrl } = {}) {
    await load();
    const override = state.overrides[modelKey(model)];
    if (override) return { price: override, priceSource: PRICE_SOURCES.OVERRIDE };
    if (LOCAL_PROVIDERS.has(providerId) || isLoopbackUrl(baseUrl)) {
      return { price: null, priceSource: PRICE_SOURCES.LOCAL };
    }
    const found = findModelPrice(activeTable().models, { providerId, model });
    if (found) return { price: found.price, priceSource: PRICE_SOURCES.TABLE };
    return { price: null, priceSource: null };
  }

  /** What the settings show for these models: price, source, override. */
  async function describe(models = []) {
    await load();
    const table = activeTable();
    const rows = [];
    for (const entry of Array.isArray(models) ? models : []) {
      const model = typeof entry?.model === 'string' ? entry.model : '';
      if (!model) continue;
      const providerId = typeof entry.providerId === 'string' ? entry.providerId : '';
      const resolved = await resolve({ providerId, model, baseUrl: entry.baseUrl });
      const tablePrice = findModelPrice(table.models, { providerId, model });
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

  /** Sets (price) or clears (null) the override of one model. */
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
    const trimmed = trimLiteLlmPrices(json);
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
