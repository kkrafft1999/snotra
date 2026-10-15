'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUsage, mergeUsage } = require('../src/shared/contracts/usage');
const {
  PRICE_SOURCES,
  trimLiteLlmPrices,
  priceKeyCandidates,
  findModelPrice,
  createCostEntry,
  normalizeSessionCost,
  mergeSessionCost,
  summarizeSessionCost,
  costEntryUsd,
  formatUsd,
  MIN_PRICE_TABLE_MODELS,
} = require('../src/shared/contracts/cost');

const PRICE = { input: 2e-6, output: 10e-6, cacheRead: 0.5e-6, cacheWrite: 2.5e-6 };

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message || ''} ${actual} != ${expected}`);
}

test('usage keeps cache writes and reasoning apart without changing the old shape (#949)', () => {
  // OpenAI: reasoning is a part of output_tokens.
  assert.deepEqual(
    normalizeUsage({ input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } }),
    { prompt: 100, completion: 50, total: 150, cached: 0, reasoning: 30 }
  );
  // Chat Completions: the same under another key.
  assert.equal(
    normalizeUsage({ prompt_tokens: 10, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 5 } }).reasoning,
    5
  );
  // Google reports thoughts next to the candidates — they are output too.
  assert.deepEqual(
    normalizeUsage({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 }),
    { prompt: 100, completion: 50, total: 150, cached: 0, reasoning: 30 }
  );
  // Without either, the shape the token display knows is untouched.
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5 }), {
    prompt: 10, completion: 5, total: 15, cached: 0,
  });
  // Normalising twice does not grow anything.
  const once = normalizeUsage({ input_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 20 });
  assert.deepEqual(normalizeUsage(once), once);
  const gemini = normalizeUsage({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 });
  assert.deepEqual(normalizeUsage(gemini), gemini);
});

test('mergeUsage sums cache writes and reasoning over the rounds (#949)', () => {
  const merged = mergeUsage(
    { prompt: 100, completion: 10, total: 110, cached: 0, cacheWrite: 40, reasoning: 4 },
    { prompt: 200, completion: 20, total: 220, cached: 100, reasoning: 6 }
  );
  assert.deepEqual(merged, { prompt: 300, completion: 30, total: 330, cached: 100, cacheWrite: 40, reasoning: 10 });
});

test('trimLiteLlmPrices keeps the chat models of the known providers and rejects anything else', () => {
  const source = {
    sample_spec: { litellm_provider: 'one of …', mode: 'one of …', input_cost_per_token: 0, output_cost_per_token: 0 },
    'GPT-X': {
      litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6,
      cache_read_input_token_cost: 1e-7, input_cost_per_token_batches: 5e-7,
    },
    'dall-e-3': { litellm_provider: 'openai', mode: 'image_generation', input_cost_per_token: 1, output_cost_per_token: 1 },
    'bedrock/claude': { litellm_provider: 'bedrock', mode: 'chat', input_cost_per_token: 1, output_cost_per_token: 1 },
    'no-output': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6 },
  };
  for (let i = 0; i < MIN_PRICE_TABLE_MODELS; i += 1) {
    source[`filler-${i}`] = { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 };
  }
  const trimmed = trimLiteLlmPrices(source);
  assert.deepEqual(trimmed.models['gpt-x'], { input: 1e-6, output: 2e-6, cacheRead: 1e-7 });
  assert.equal(trimmed.models['dall-e-3'], undefined);
  assert.equal(trimmed.models['bedrock/claude'], undefined);
  assert.equal(trimmed.models['no-output'], undefined);
  assert.equal(trimmed.models.sample_spec, undefined);
  // Too small to be the table, or not a table at all.
  assert.equal(trimLiteLlmPrices({ 'gpt-x': source['GPT-X'] }), null);
  assert.equal(trimLiteLlmPrices([]), null);
  assert.equal(trimLiteLlmPrices('<html>'), null);
});

test('the bundled snapshot is a valid table with the models people use', () => {
  const snapshot = require('../src/main/data/model-prices.json');
  assert.match(snapshot.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Object.keys(snapshot.models).length >= MIN_PRICE_TABLE_MODELS);
  for (const [providerId, model] of [['openai', 'gpt-5'], ['anthropic', 'claude-sonnet-4-5'], ['google', 'gemini-2.5-pro']]) {
    assert.ok(findModelPrice(snapshot.models, { providerId, model }), `${model} is priced`);
  }
});

test('model IDs are matched with prefix, vendor and date variants', () => {
  assert.deepEqual(priceKeyCandidates('google', 'models/Gemini-2.5-Pro'), ['gemini-2.5-pro', 'gemini/gemini-2.5-pro']);
  assert.ok(priceKeyCandidates('openai', 'gpt-x-2026-01-31').includes('gpt-x'));
  assert.ok(priceKeyCandidates('anthropic', 'claude-x-20260131').includes('claude-x'));
  assert.ok(priceKeyCandidates('openai-compatible', 'anthropic/claude-x').includes('claude-x'));
  assert.deepEqual(priceKeyCandidates('openai', ''), []);

  const models = { 'gpt-x': PRICE, 'gpt-x-2026-01-31': { input: 9, output: 9 }, 'gemini/gemini-y': PRICE };
  // The dated key wins where the table has it; the alias covers the rest.
  assert.equal(findModelPrice(models, { providerId: 'openai', model: 'gpt-x-2026-01-31' }).key, 'gpt-x-2026-01-31');
  assert.equal(findModelPrice(models, { providerId: 'openai', model: 'gpt-x-2026-02-28' }).key, 'gpt-x');
  assert.equal(findModelPrice(models, { providerId: 'google', model: 'gemini-y' }).key, 'gemini/gemini-y');
  assert.equal(findModelPrice(models, { providerId: 'openai', model: 'unknown' }), null);
});

test('a round is priced per kind of token', () => {
  const entry = createCostEntry({
    providerId: 'anthropic',
    model: 'claude-x',
    usage: { input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1000, output_tokens: 500 },
    price: PRICE,
    priceSource: PRICE_SOURCES.TABLE,
  });
  assert.deepEqual(entry.tokens, { input: 1000, cacheRead: 8000, cacheWrite: 1000, output: 500, reasoning: 0 });
  close(entry.usd.input, 1000 * 2e-6);
  close(entry.usd.cacheRead, 8000 * 0.5e-6);
  close(entry.usd.cacheWrite, 1000 * 2.5e-6);
  close(entry.usd.output, 500 * 10e-6);
  close(costEntryUsd(entry), 0.002 + 0.004 + 0.0025 + 0.005);
});

test('cache prices fall back to input, reasoning to output unless the table names it', () => {
  const usage = { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 60 } };
  const plain = createCostEntry({ providerId: 'openai', model: 'm', usage, price: { input: 1e-6, output: 4e-6 }, priceSource: PRICE_SOURCES.TABLE });
  close(plain.usd.cacheRead, 400 * 1e-6);
  close(plain.usd.output, 100 * 4e-6);
  const withReasoning = createCostEntry({
    providerId: 'openai', model: 'm', usage, price: { input: 1e-6, output: 4e-6, reasoning: 8e-6 }, priceSource: PRICE_SOURCES.TABLE,
  });
  close(withReasoning.usd.output, 40 * 4e-6 + 60 * 8e-6);
});

test('an unknown model is unpriced, never free; a local one is free', () => {
  const unknown = createCostEntry({ providerId: 'openai-compatible', model: 'my-model', usage: { prompt_tokens: 10, completion_tokens: 5 } });
  assert.equal(unknown.usd, null);
  assert.equal(unknown.unpricedRounds, 1);
  assert.equal(costEntryUsd(unknown), null);
  const summary = summarizeSessionCost({ models: [unknown] });
  assert.equal(summary.usd, null);
  assert.equal(formatUsd(summary.usd), '–');

  const local = createCostEntry({ providerId: 'ollama', model: 'llama', usage: { prompt_eval_count: 10, eval_count: 5 }, priceSource: PRICE_SOURCES.LOCAL });
  assert.equal(costEntryUsd(local), 0);
  assert.equal(local.priceSource, PRICE_SOURCES.LOCAL);
});

test('the chat sum keeps one entry per model across a model switch', () => {
  const round = (model, price) => createCostEntry({
    providerId: 'openai', model, usage: { input_tokens: 1000, output_tokens: 100 }, price, priceSource: PRICE_SOURCES.TABLE,
  });
  let cost = null;
  cost = mergeSessionCost(cost, { models: [round('a', PRICE)], priceTable: { date: '2026-10-01', origin: 'bundled' } });
  cost = mergeSessionCost(cost, { models: [round('b', { input: 1e-6, output: 1e-6 })] });
  cost = mergeSessionCost(cost, { models: [round('a', PRICE)], priceTable: { date: '2026-10-15', origin: 'downloaded' } });
  assert.equal(cost.models.length, 2);
  const a = cost.models.find((m) => m.model === 'a');
  assert.equal(a.rounds, 2);
  assert.equal(a.tokens.input, 2000);
  close(costEntryUsd(a), 2 * (1000 * 2e-6 + 100 * 10e-6));
  // The table of the latest round is the one named.
  assert.deepEqual(cost.priceTable, { date: '2026-10-15', origin: 'downloaded' });
  const summary = summarizeSessionCost(cost);
  close(summary.usd, 2 * 0.003 + 1100 * 1e-6);
  assert.equal(summary.complete, true);
  assert.equal(summary.tokens.input, 3000);
});

test('a sum with unpriced rounds is partial and names the model', () => {
  const priced = createCostEntry({ providerId: 'openai', model: 'a', usage: { input_tokens: 1000, output_tokens: 0 }, price: PRICE, priceSource: PRICE_SOURCES.TABLE });
  const unpriced = createCostEntry({ providerId: 'openai', model: 'x', usage: { input_tokens: 1000, output_tokens: 0 } });
  const summary = summarizeSessionCost(mergeSessionCost({ models: [priced] }, { models: [unpriced] }));
  close(summary.usd, 0.002);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.unpricedModels, ['x']);
});

test('normalizeSessionCost repairs what the history file holds', () => {
  assert.equal(normalizeSessionCost(null), null);
  assert.equal(normalizeSessionCost({ models: [] }), null);
  assert.equal(normalizeSessionCost({ models: 'nope' }), null);
  const cost = normalizeSessionCost({
    models: [
      { providerId: 'openai', model: 'a', tokens: { input: -5, output: '7' }, usd: { input: 'x', output: 0.5 }, rounds: 0, priceSource: 'bogus' },
      { nothing: true },
    ],
    priceTable: { date: 'yesterday' },
  });
  assert.equal(cost.models.length, 1);
  assert.deepEqual(cost.models[0].tokens, { input: 0, cacheRead: 0, cacheWrite: 0, output: 7, reasoning: 0 });
  assert.deepEqual(cost.models[0].usd, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0.5 });
  assert.equal(cost.models[0].rounds, 1);
  assert.equal(cost.models[0].priceSource, null);
  assert.equal(cost.priceTable, undefined);
});

test('formatUsd follows the locale and never rounds a cost down to nothing', () => {
  assert.equal(formatUsd(0.42, 'en'), '$0.42');
  assert.equal(formatUsd(0.42, 'de').replace(/\s/g, ' '), '0,42 $');
  assert.equal(formatUsd(0, 'en'), '$0.00');
  assert.equal(formatUsd(0.004, 'en'), '<$0.01');
  assert.equal(formatUsd(null, 'en'), '–');
  assert.equal(formatUsd(undefined, 'en'), '–');
});
