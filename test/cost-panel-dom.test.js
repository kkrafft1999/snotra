// The estimated chat cost in the composer bar and in Settings › Models (#949).
//
// The markup comes from the real index.html — a missing ID fails here, not in
// the app. Checked is the wiring: when the chip shows, what it says for a
// known, a partly known and an unknown price, what the popover lists, and
// what the price form accepts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');
const { createCostEntry, mergeSessionCost } = require('../src/shared/contracts/cost');

const PRICE = { input: 2e-6, output: 10e-6, cacheRead: 0.5e-6 };

function round(model, usage, { price = PRICE, priceSource = 'table' } = {}) {
  return createCostEntry({ providerId: 'openai', model, usage, price, priceSource });
}

function chatCost(...entries) {
  return entries.reduce(
    (cost, entry) => mergeSessionCost(cost, { models: [entry], priceTable: { date: '2026-10-15', origin: 'bundled' } }),
    null
  );
}

async function mountCost(cost, { locale = 'en', onOpenPriceSettings } = {}) {
  const dom = setupRendererDom();
  const i18n = await importRenderer('i18n.js');
  i18n.setLocale(locale, { force: true });
  const { initCostPanel } = await importRenderer('components', 'CostPanel.js');
  const state = { cost };
  const trigger = dom.document.getElementById('chat-cost');
  const panel = dom.document.getElementById('chat-cost-breakdown');
  const api = initCostPanel({
    trigger,
    valueEl: dom.document.getElementById('chat-cost-value'),
    panel,
    getCost: () => state.cost,
    onOpenPriceSettings,
  });
  return { dom, api, trigger, panel, state, wrap: trigger.closest('.chat-cost-wrap') };
}

function click(node) {
  node.dispatchEvent(new node.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}

test('the chip stays hidden until a round was spent, then shows the sum', async () => {
  const { api, wrap, trigger, state } = await mountCost(null);
  assert.equal(wrap.hidden, true, 'no "$0.00" on a chat that spent nothing');

  state.cost = chatCost(round('gpt-x', { input_tokens: 100000, output_tokens: 10000 }));
  api.refresh();
  assert.equal(wrap.hidden, false);
  assert.equal(trigger.textContent.trim(), '~$0.30');
  assert.match(trigger.getAttribute('aria-label'), /Estimated cost of this chat: ~\$0\.30/);
  assert.equal(trigger.tagName, 'BUTTON');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');

  // Another chat on screen, one without cost: the chip goes again.
  state.cost = null;
  api.refresh();
  assert.equal(wrap.hidden, true);
});

test('an unknown price shows a dash, never zero; a partly known one ends in +', async () => {
  const unknown = await mountCost(chatCost(round('mine', { input_tokens: 10, output_tokens: 5 }, { price: null, priceSource: null })));
  assert.equal(unknown.trigger.textContent.trim(), '–');
  assert.match(unknown.trigger.getAttribute('aria-label'), /unknown/);

  const partial = await mountCost(chatCost(
    round('gpt-x', { input_tokens: 100000, output_tokens: 10000 }),
    round('mine', { input_tokens: 10, output_tokens: 5 }, { price: null, priceSource: null })
  ));
  assert.equal(partial.trigger.textContent.trim(), '~$0.30+');
});

test('the popover lists every model with its kinds of token and the table date', async () => {
  const { trigger, panel, api } = await mountCost(chatCost(
    round('gpt-x', { input_tokens: 10000, input_tokens_details: { cached_tokens: 4000 }, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 600 } }),
    round('gpt-y', { input_tokens: 1000, output_tokens: 100 }, { price: null, priceSource: null })
  ), { onOpenPriceSettings: () => {} });
  click(trigger);
  assert.equal(api.isOpen(), true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.querySelector(`#${panel.getAttribute('aria-labelledby')}`).tagName, 'H2');

  const models = [...panel.querySelectorAll('.chat-cost__model-name')].map((n) => n.textContent);
  assert.deepEqual(models, ['gpt-x', 'gpt-y']);
  const firstRows = [...panel.querySelectorAll('.chat-cost__model')[0].querySelectorAll('tbody th')].map((n) => n.textContent);
  assert.deepEqual(firstRows, ['Input', 'Read from the cache', 'Output (of which 600 reasoning)']);
  // The unknown model: dash for its total and its rows, and the way to a price.
  const second = panel.querySelectorAll('.chat-cost__model')[1];
  assert.equal(second.querySelector('.chat-cost__model-total').textContent, '–');
  assert.ok(second.querySelector('.chat-cost__link'));
  assert.match(panel.textContent, /LiteLLM table of Oct 15, 2026/);
  assert.match(panel.textContent, /Not included: image generation/);

  // Escape closes and gives the focus back.
  panel.dispatchEvent(new panel.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(api.isOpen(), false);
});

test('"Set a price" closes the popover and asks for that model\'s settings', async () => {
  const asked = [];
  const { trigger, panel, api } = await mountCost(
    chatCost(round('mine', { input_tokens: 10, output_tokens: 5 }, { price: null, priceSource: null })),
    { onOpenPriceSettings: (model) => asked.push(model) }
  );
  click(trigger);
  click(panel.querySelector('.chat-cost__link'));
  assert.deepEqual(asked, ['mine']);
  assert.equal(api.isOpen(), false);
});

test('a local model shows as free', async () => {
  const { trigger, panel } = await mountCost(chatCost(
    createCostEntry({ providerId: 'ollama', model: 'llama', usage: { prompt_eval_count: 100, eval_count: 10 }, priceSource: 'local' })
  ));
  assert.equal(trigger.textContent.trim(), '~$0.00');
  click(trigger);
  assert.match(panel.textContent, /Runs on your computer/);
});

test('German formats the amount the German way', async () => {
  const { trigger } = await mountCost(chatCost(round('gpt-x', { input_tokens: 100000, output_tokens: 10000 })), { locale: 'de' });
  assert.equal(trigger.textContent.trim().replace(/\s/g, ' '), '~0,30 $');
});

// ── Settings › Models › Prices ────────────────────────────────────────────

async function mountPrices(describe, { setOverride = async () => ({ ok: true }), updateModelPrices } = {}) {
  const dom = setupRendererDom();
  const i18n = await importRenderer('i18n.js');
  i18n.setLocale('en', { force: true });
  const { initModelPricesSettings } = await importRenderer('components', 'ModelPricesSettings.js');
  const calls = { set: [], describe: 0, update: 0 };
  const api = {
    describeModelPrices: async (models) => {
      calls.describe += 1;
      return describe(models);
    },
    setModelPriceOverride: async (model, price) => {
      calls.set.push([model, price]);
      return setOverride(model, price);
    },
    updateModelPrices: updateModelPrices || (async () => {
      calls.update += 1;
      return { ok: true, modelCount: 200 };
    }),
  };
  const prices = initModelPricesSettings({
    root: dom.document.getElementById('settings-model-prices-card'),
    api,
    getModels: () => [{ providerId: 'openai', model: 'gpt-x' }, { providerId: 'openai-compatible', model: 'mine' }],
  });
  await prices.refresh();
  return { dom, prices, calls, root: dom.document.getElementById('settings-model-prices-card') };
}

function describedPrices() {
  return {
    table: { date: '2026-10-15', origin: 'bundled', modelCount: 186 },
    models: [
      { providerId: 'openai', model: 'gpt-x', priceSource: 'table', price: { input: 1.75e-6, output: 14e-6 }, tablePrice: { input: 1.75e-6, output: 14e-6 }, override: null },
      { providerId: 'openai-compatible', model: 'mine', priceSource: null, price: null, tablePrice: null, override: null },
    ],
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('the price list names the table and every model with its source', async () => {
  const { root } = await mountPrices(describedPrices);
  assert.match(root.querySelector('#model-prices-table').textContent, /Oct 15, 2026, shipped with Snotra · 186 models/);
  const rows = [...root.querySelectorAll('.model-prices__row')];
  assert.deepEqual(rows.map((r) => r.dataset.model), ['gpt-x', 'mine']);
  assert.match(rows[0].textContent, /Price table/);
  assert.match(rows[0].textContent, /In \$1\.75 · Out \$14\.00 per 1M tokens/);
  assert.match(rows[1].textContent, /No price known/);
});

test('a price of one\'s own is checked, converted per token and saved', async () => {
  const { root, calls } = await mountPrices(describedPrices);
  click(root.querySelector('.model-prices__row[data-model="mine"] [data-action="edit"]'));
  const form = root.querySelector('.model-prices__row[data-model="mine"] form');
  assert.ok(form);

  // Output missing: refused, field marked, nothing sent.
  form.elements.namedItem('input').value = '1,25';
  form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(calls.set.length, 0);
  assert.equal(form.elements.namedItem('output').getAttribute('aria-invalid'), 'true');
  assert.equal(form.querySelector('.model-prices__error').classList.contains('hidden'), false);

  form.elements.namedItem('output').value = '10';
  form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(calls.set.length, 1);
  const [model, price] = calls.set[0];
  assert.equal(model, 'mine');
  assert.ok(Math.abs(price.input - 1.25e-6) < 1e-15);
  assert.ok(Math.abs(price.output - 10e-6) < 1e-15);
  assert.equal('cacheRead' in price, false, 'empty optional prices are left out');
});

test('a failed price update says so and keeps the list', async () => {
  const { root } = await mountPrices(describedPrices, { updateModelPrices: async () => ({ ok: false, code: 'network' }) });
  click(root.querySelector('#btn-model-prices-update'));
  await settle();
  const status = root.querySelector('#model-prices-status');
  assert.match(status.textContent, /could not be fetched\. The previous prices stay in use/);
  assert.equal(status.classList.contains('error'), true);
  assert.equal(root.querySelectorAll('.model-prices__row').length, 2);
});
