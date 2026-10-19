'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createModelPriceService, isLoopbackUrl, UPDATE_ERROR_CODES } = require('../src/main/services/model-price-service');
const { PRICE_SOURCES, LITELLM_PRICES_URL, MIN_PRICE_TABLE_MODELS } = require('../src/shared/contracts/cost');
const { removeTempDirSync } = require('./helpers/temp-dir');

const SNAPSHOT = {
  date: '2026-10-01',
  models: {
    'gpt-x': { input: 1e-6, output: 2e-6 },
    'gemini/gemini-y': { input: 3e-6, output: 4e-6 },
  },
};

function liteLlmTable(extra = {}) {
  const table = { ...extra };
  for (let i = 0; i < MIN_PRICE_TABLE_MODELS; i += 1) {
    table[`filler-${i}`] = { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 };
  }
  return table;
}

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-prices-'));
  t.after(() => removeTempDirSync(dir));
  const make = (more = {}) => createModelPriceService({
    fs: fs.promises,
    path,
    userDataPath: dir,
    snapshot: SNAPSHOT,
    now: () => new Date('2026-10-15T12:00:00Z'),
    log: { warn() {} },
    ...options,
    ...more,
  });
  return { dir, make };
}

test('isLoopbackUrl recognises servers on this machine', () => {
  assert.equal(isLoopbackUrl('http://localhost:1234/v1'), true);
  assert.equal(isLoopbackUrl('http://127.0.0.1:8080/v1'), true);
  assert.equal(isLoopbackUrl('http://[::1]:8000'), true);
  assert.equal(isLoopbackUrl('http://studio.localhost/v1'), true);
  assert.equal(isLoopbackUrl('https://openrouter.ai/api/v1'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
  assert.equal(isLoopbackUrl(''), false);
});

test('resolve: table, local, unknown', async (t) => {
  const { make } = setup(t);
  const prices = make();
  assert.deepEqual(await prices.resolve({ providerId: 'openai', model: 'gpt-x' }), {
    price: SNAPSHOT.models['gpt-x'],
    priceSource: PRICE_SOURCES.TABLE,
  });
  assert.equal((await prices.resolve({ providerId: 'google', model: 'gemini-y' })).priceSource, PRICE_SOURCES.TABLE);
  assert.equal((await prices.resolve({ providerId: 'ollama', model: 'llama' })).priceSource, PRICE_SOURCES.LOCAL);
  assert.equal(
    (await prices.resolve({ providerId: 'openai-compatible', model: 'gpt-x', baseUrl: 'http://localhost:1234/v1' })).priceSource,
    PRICE_SOURCES.LOCAL
  );
  assert.deepEqual(await prices.resolve({ providerId: 'openai-compatible', model: 'mine', baseUrl: 'https://llm.example.com/v1' }), {
    price: null,
    priceSource: null,
  });
  assert.deepEqual(await prices.tableInfo(), { date: '2026-10-01', origin: 'bundled' });
});

test('an override beats the table and survives a restart', async (t) => {
  const { make } = setup(t);
  const prices = make();
  assert.deepEqual(await prices.setOverride('GPT-X', { input: 5e-6, output: 6e-6, cacheRead: 1e-6 }), { ok: true });
  assert.deepEqual(await prices.resolve({ providerId: 'openai', model: 'gpt-x' }), {
    price: { input: 5e-6, output: 6e-6, cacheRead: 1e-6 },
    priceSource: PRICE_SOURCES.OVERRIDE,
  });
  const again = make();
  assert.equal((await again.resolve({ providerId: 'openai', model: 'gpt-x' })).priceSource, PRICE_SOURCES.OVERRIDE);
  // An unknown model becomes priced through an override as well.
  await again.setOverride('mine', { input: 1e-6, output: 1e-6 });
  assert.equal((await again.resolve({ providerId: 'openai-compatible', model: 'mine' })).priceSource, PRICE_SOURCES.OVERRIDE);
  // It wins over "local" too: a proxy on this machine may forward to a paid API.
  await again.setOverride('proxied', { input: 2e-6, output: 2e-6 });
  assert.equal(
    (await again.resolve({ providerId: 'openai-compatible', model: 'proxied', baseUrl: 'http://localhost:4000' })).priceSource,
    PRICE_SOURCES.OVERRIDE
  );
  // Clearing it brings the table back.
  await again.setOverride('gpt-x', null);
  assert.equal((await again.resolve({ providerId: 'openai', model: 'gpt-x' })).priceSource, PRICE_SOURCES.TABLE);
  // Nonsense is refused, nothing changes.
  assert.deepEqual(await again.setOverride('gpt-x', { input: -1, output: 1 }), { ok: false });
  assert.deepEqual(await again.setOverride('', { input: 1, output: 1 }), { ok: false });
});

test('describe lists price, source, table price and override per model', async (t) => {
  const { make } = setup(t);
  const prices = make();
  await prices.setOverride('gpt-x', { input: 9e-6, output: 9e-6 });
  const described = await prices.describe([
    { providerId: 'openai', model: 'gpt-x' },
    { providerId: 'openai-compatible', model: 'mine', baseUrl: 'https://llm.example.com' },
    { providerId: 'ollama', model: 'llama' },
    { providerId: 'openai', model: '' },
  ]);
  assert.deepEqual(described.table, { date: '2026-10-01', origin: 'bundled', modelCount: 2 });
  assert.deepEqual(described.models.map((m) => [m.model, m.priceSource]), [
    ['gpt-x', PRICE_SOURCES.OVERRIDE],
    ['mine', null],
    ['llama', PRICE_SOURCES.LOCAL],
  ]);
  assert.deepEqual(described.models[0].tablePrice, SNAPSHOT.models['gpt-x']);
  assert.deepEqual(described.models[0].override, { input: 9e-6, output: 9e-6 });
});

test('updateTable fetches only the fixed URL and replaces the table on success', async (t) => {
  const calls = [];
  const { make } = setup(t, {
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => liteLlmTable({ 'gpt-x': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 7e-6, output_cost_per_token: 8e-6 } }) };
    },
  });
  const prices = make();
  // Nothing goes online by itself.
  await prices.resolve({ providerId: 'openai', model: 'gpt-x' });
  assert.equal(calls.length, 0);

  const result = await prices.updateTable();
  assert.equal(result.ok, true);
  assert.equal(result.date, '2026-10-15');
  assert.deepEqual(calls, [LITELLM_PRICES_URL]);
  assert.deepEqual((await prices.resolve({ providerId: 'openai', model: 'gpt-x' })).price, { input: 7e-6, output: 8e-6 });
  assert.deepEqual(await prices.tableInfo(), { date: '2026-10-15', origin: 'downloaded' });
  // Kept for the next start.
  const again = make({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(await again.tableInfo(), { date: '2026-10-15', origin: 'downloaded' });
});

test('a failed update leaves the table in use and says why', async (t) => {
  const cases = [
    [async () => { throw new TypeError('fetch failed'); }, UPDATE_ERROR_CODES.NETWORK],
    [async () => ({ ok: false, status: 503, json: async () => ({}) }), UPDATE_ERROR_CODES.NETWORK],
    [async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }), UPDATE_ERROR_CODES.INVALID],
    [async () => ({ ok: true, json: async () => ({ just: 'something' }) }), UPDATE_ERROR_CODES.INVALID],
  ];
  for (const [fetchImpl, code] of cases) {
    const { make } = setup(t, { fetchImpl });
    const prices = make();
    const result = await prices.updateTable();
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.deepEqual(await prices.tableInfo(), { date: '2026-10-01', origin: 'bundled' });
    assert.equal((await prices.resolve({ providerId: 'openai', model: 'gpt-x' })).priceSource, PRICE_SOURCES.TABLE);
  }
});

test('a download older than the shipped snapshot gives way to it', async (t) => {
  const { dir, make } = setup(t);
  fs.writeFileSync(path.join(dir, 'model-prices.json'), JSON.stringify({
    overrides: {},
    table: { date: '2026-09-01', models: { 'gpt-x': { input: 1, output: 1 } } },
  }));
  const prices = make();
  assert.deepEqual(await prices.tableInfo(), { date: '2026-10-01', origin: 'bundled' });
  assert.deepEqual((await prices.resolve({ providerId: 'openai', model: 'gpt-x' })).price, SNAPSHOT.models['gpt-x']);
});

test('an unreadable price file is treated as none', async (t) => {
  const { dir, make } = setup(t);
  fs.writeFileSync(path.join(dir, 'model-prices.json'), '{ broken');
  const prices = make();
  assert.equal((await prices.resolve({ providerId: 'openai', model: 'gpt-x' })).priceSource, PRICE_SOURCES.TABLE);
});
