// The usage report dialog (#1258) on the real index.html.
//
// Checked is the wiring: what opens it and where the focus goes, what the
// totals and the rows say for a priced, an unpriced and a local model, the
// switch of dimension, a row unfolded and its chats, opening a chat in
// another folder, the grouping by kind of task and changing a chat's kind
// there (#1283) — and the states without a report: empty, failed, a custom
// range without both days. The figures themselves come from the contract and
// are tested there (usage-report.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');
const { datedSessionCost, mergeSessionCost } = require('../src/shared/contracts/cost');
const { buildUsageReport } = require('../src/shared/contracts/usage-report');

const DAY = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

function spend(providerId, model, usd, rounds = 1) {
  return {
    providerId,
    model,
    tokens: { input: 1000, cacheRead: 400, cacheWrite: 0, output: 200, reasoning: 50 },
    usd: usd === null ? null : { input: usd / 2, cacheRead: 0, cacheWrite: 0, output: usd / 2 },
    priceSource: usd === null ? null : (usd === 0 ? 'local' : 'table'),
    rounds,
    unpricedRounds: usd === null ? rounds : 0,
  };
}

const chat = (id, workspaceRoot, title, ...models) => ({
  id,
  workspaceRoot,
  title,
  updatedAt: Date.now(),
  cost: mergeSessionCost(null, datedSessionCost({ models, priceTable: { date: '2026-10-15', origin: 'bundled' } }, DAY)),
});

const CHATS = [
  chat('a', '/work/garden', 'Crop rotation', spend('openai', 'gpt-5', 2)),
  chat('b', '/work/site', 'Navigation', spend('anthropic', 'claude-sonnet', 1), spend('openai', 'gpt-5', 0.5)),
  chat('c', '/work/site', 'Review', spend('openai-compatible', 'mystery', null)),
  chat('d', null, 'Meeting notes', spend('ollama', 'qwen3', 0)),
];

async function mount(t, { locale = 'en', getUsageReport, setChatTaskKind, activeRoot = '/work/garden', openFolder = async () => true } = {}) {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const i18n = await importRenderer('i18n.js');
  i18n.setLocale(locale, { force: true });
  const { initUsageReportDialog } = await importRenderer('components', 'UsageReportDialog.js');
  const calls = { report: [], folders: [], chats: [] };
  let openFromMenu = null;
  const api = {
    getUsageReport: getUsageReport || (async (period) => {
      calls.report.push(period);
      return buildUsageReport(CHATS, period, { maxChats: 200 });
    }),
    onOpenUsageReport: (fn) => { openFromMenu = fn; },
    setChatTaskKind,
  };
  const dialog = initUsageReportDialog({
    api,
    getActiveRoot: () => activeRoot,
    openFolder: async (root) => { calls.folders.push(root); return openFolder(root); },
    openChat: async (id) => { calls.chats.push(id); },
  });
  const { document } = dom;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const choose = async (name, value) => {
    const input = $(`input[name="${name}"][value="${value}"]`);
    input.checked = true;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
  };
  return { dom, document, dialog, calls, settle, $, $$, click, choose, openFromMenu: () => openFromMenu() };
}

const rowNames = ($$) => $$('#usage-table .usage-table__row .usage-table__name-main').map((node) => node.textContent);

test('the menu opens it, the focus goes to the period, Escape closes and gives the focus back', async (t) => {
  const ui = await mount(t);
  const button = ui.$('#btn-sidebar-usage');
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(button.getAttribute('aria-label'), 'Usage & cost…');
  button.focus();
  ui.openFromMenu();
  await ui.settle();
  assert.equal(ui.dialog.isOpen(), true);
  assert.equal(ui.document.activeElement.value, 'last30');
  assert.equal(ui.calls.report.length, 1);
  assert.equal(ui.calls.report[0].to, DAY);

  ui.$('#modal-usage').dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.dialog.isOpen(), false);
  assert.equal(ui.document.activeElement === button, true);
});

test('totals, an unknown price as a dash, a local model as $0.00 local', async (t) => {
  const ui = await mount(t);
  ui.dialog.open();
  await ui.settle();
  const totals = ui.$$('#usage-summary .usage-dialog__total-value').map((node) => node.textContent);
  assert.deepEqual(totals, ['~$3.50+', '8.0 K', '4']);
  assert.match(ui.$('.usage-dialog__estimate').textContent, /LiteLLM table of Oct 15, 2026\. A \+ means/);
  assert.deepEqual(rowNames(ui.$$), ['gpt-5', 'claude-sonnet', 'qwen3', 'mystery']);
  const costs = Object.fromEntries(ui.$$('#usage-table .usage-table__row')
    .map((row) => [row.querySelector('.usage-table__name-main').textContent, row.querySelector('.usage-table__cost').textContent]));
  assert.deepEqual(costs, { 'gpt-5': '~$2.50', 'claude-sonnet': '~$1.00', qwen3: '$0.00local', mystery: '–no price' });
  assert.equal(ui.$$('.usage-chart__slot').length, 30, 'a bar per day of the 30');
  assert.match(ui.$('.usage-chart__plot').getAttribute('aria-label'), /^Cost per day, .*Highest: ~\$3\.50/);
});

test('by workspace, a row unfolds into its models and its chats, sorting by name', async (t) => {
  const ui = await mount(t);
  ui.dialog.open();
  await ui.settle();
  await ui.choose('usage-group', 'workspaces');
  assert.deepEqual(rowNames(ui.$$), ['garden', 'site', 'Without a folder']);

  const site = ui.$$('#usage-table .usage-table__group')[1];
  const disclosure = site.querySelector('.usage-table__disclosure');
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(disclosure.getAttribute('aria-label'), 'Models in site');
  assert.equal(site.querySelector('.usage-table__child').hidden, true);
  disclosure.focus();
  ui.click(disclosure);
  const unfolded = ui.$$('#usage-table .usage-table__group')[1];
  assert.deepEqual([...unfolded.querySelectorAll('.usage-table__child .usage-table__name-main')].map((n) => n.textContent),
    ['claude-sonnet', 'gpt-5', 'mystery']);
  assert.equal([...unfolded.querySelectorAll('.usage-table__child, .usage-table__detail')].every((row) => !row.hidden), true);
  assert.match(unfolded.querySelector('.usage-table__detail').textContent, /^Input 3\.0 K · Read from the cache 1\.2 K · Output 600, of which 150 reasoning$/);
  assert.equal(ui.document.activeElement.dataset.focus, disclosure.dataset.focus, 'the focus stays on the redrawn button');

  ui.click(unfolded.querySelector('.usage-table__chats'));
  const items = ui.$$('#usage-table .usage-chats__item .usage-chats__title').map((n) => n.textContent);
  assert.deepEqual(items, ['Navigation', 'Review']);

  ui.click(ui.$('#usage-table thead .usage-table__sort'));
  assert.deepEqual(rowNames(ui.$$), ['garden', 'site', 'Without a folder'], 'A to Z');
  assert.equal(ui.$('#usage-table thead th').getAttribute('aria-sort'), 'ascending');
  ui.click(ui.$('#usage-table thead .usage-table__sort'));
  assert.deepEqual(rowNames(ui.$$), ['Without a folder', 'site', 'garden'], 'and back');
});

test('a chat in another folder opens there; a folder that will not open says so and keeps the report', async (t) => {
  let folderOpens = true;
  const ui = await mount(t, { openFolder: async () => folderOpens });
  ui.dialog.open();
  await ui.settle();
  await ui.choose('usage-group', 'workspaces');
  const site = () => ui.$$('#usage-table .usage-table__group')[1];
  ui.click(site().querySelector('.usage-table__chats'));

  folderOpens = false;
  ui.click(site().querySelector('.usage-chats__open'));
  await ui.settle();
  assert.deepEqual(ui.calls.folders, ['/work/site']);
  assert.deepEqual(ui.calls.chats, []);
  assert.equal(ui.dialog.isOpen(), true);
  assert.equal(ui.$('#usage-alert').hidden, false);
  assert.equal(ui.$('#usage-alert').textContent, 'The folder /work/site could not be opened.');

  folderOpens = true;
  ui.click(site().querySelector('.usage-chats__open'));
  await ui.settle();
  assert.deepEqual(ui.calls.chats, ['b']);
  assert.equal(ui.dialog.isOpen(), false);

  // A chat without a folder has no Open while a folder is open.
  ui.dialog.open();
  await ui.settle();
  const loose = ui.$$('#usage-table .usage-table__group')[2];
  ui.click(loose.querySelector('.usage-table__chats'));
  const looseNow = ui.$$('#usage-table .usage-table__group')[2];
  assert.equal(looseNow.querySelector('.usage-chats__open'), null);
  assert.match(looseNow.querySelector('.usage-chats__note').textContent, /opens only while no folder is open/);
});

test('the chart as a table, in German', async (t) => {
  const ui = await mount(t, { locale: 'de' });
  ui.dialog.open();
  await ui.settle();
  assert.equal(ui.$('#modal-usage-title').textContent, 'Nutzung & Kosten');
  assert.equal(ui.$('.usage-chart__title').textContent, 'Kosten pro Tag');
  ui.click(ui.$('.usage-chart__toggle'));
  const wrap = ui.$('.usage-chart__table-wrap');
  assert.equal(wrap.getAttribute('tabindex'), '0', 'it scrolls, so it takes the focus');
  const rows = [...wrap.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 30);
  // German puts a no-break space between the figure and the currency sign.
  const cells = (row) => [...row.children].slice(1).map((cell) => cell.textContent.replace(/\u00a0/g, ' '));
  assert.deepEqual(cells(rows.at(-1)), ['~3,50 $', '8,0 K']);
  assert.deepEqual(cells(rows[0]), ['0,00 $', '0'], 'a day of nothing is exactly nothing');
  assert.equal(ui.$('.usage-chart__toggle').textContent, 'Als Diagramm zeigen');
});

test('empty, failed and an incomplete custom range each say what is going on', async (t) => {
  let fail = false;
  const ui = await mount(t, {
    getUsageReport: async (period) => {
      if (fail) throw new Error('gone');
      return buildUsageReport(period.from === '2020-01-01' ? [] : CHATS, period);
    },
  });
  ui.dialog.open();
  await ui.settle();

  await ui.choose('usage-period', 'custom');
  assert.equal(ui.$('#usage-custom').hidden, false);
  assert.equal(ui.$('#usage-from').value.length, 10, 'starts from the days shown before');
  ui.$('#usage-from').value = '2020-01-01';
  ui.$('#usage-to').value = '2020-01-31';
  ui.$('#usage-to').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  await ui.settle();
  assert.match(ui.$('#usage-state').textContent, /Nothing spent in this period/);
  assert.equal(ui.$('#usage-report').hidden, true);

  ui.$('#usage-to').value = '';
  ui.$('#usage-to').dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  await ui.settle();
  assert.match(ui.$('#usage-state').textContent, /Pick a first and a last day/);

  fail = true;
  await ui.choose('usage-period', 'last7');
  assert.equal(ui.$('#usage-state').getAttribute('role'), 'alert');
  assert.match(ui.$('#usage-state').textContent, /could not be loaded/);
  fail = false;
  ui.click(ui.$('#usage-state .usage-dialog__retry'));
  await ui.settle();
  assert.equal(ui.$('#usage-report').hidden, false);
  assert.match(ui.$('#usage-footnote').textContent, /A deleted chat no longer counts/);
});

test('by kind of task: rows with what each kind means, unclassified last, a chip that changes a chat\'s kind', async (t) => {
  const kinds = { a: 'planning', b: 'coding', c: 'coding', d: null };
  const stored = [];
  let refuse = false;
  const ui = await mount(t, {
    getUsageReport: async (period) => buildUsageReport(
      CHATS.map((c) => (kinds[c.id] ? { ...c, taskKind: { id: kinds[c.id], source: 'model', at: '2026-10-25T10:00:00.000Z' } } : c)),
      period,
    ),
    setChatTaskKind: async (chatId, kindId) => {
      if (refuse) return { taskKind: null };
      stored.push([chatId, kindId]);
      kinds[chatId] = kindId;
      return { taskKind: { id: kindId, source: 'user', at: new Date().toISOString() } };
    },
  });
  ui.dialog.open();
  await ui.settle();
  await ui.choose('usage-group', 'taskKinds');
  assert.equal(ui.$('#usage-table thead th').textContent.trim(), 'Task kind');
  assert.equal(ui.$('#usage-table caption').textContent, 'Cost and tokens by kind of task');
  assert.deepEqual(rowNames(ui.$$), ['Planning & concepts', 'Coding', 'Unclassified']);
  assert.match(ui.$('#usage-table .usage-table__name-sub').textContent, /^Working out a concept/);

  // Sorted the other way round, the unclassified row stays at the bottom.
  const costHead = ui.$$('#usage-table thead .usage-table__sort').at(-1);
  ui.click(costHead);
  assert.deepEqual(rowNames(ui.$$), ['Coding', 'Planning & concepts', 'Unclassified']);

  // A kind unfolds into the models used for it.
  const coding = () => ui.$$('#usage-table .usage-table__group').find((g) => /Coding/.test(g.querySelector('.usage-table__name-main').textContent));
  ui.click(coding().querySelector('.usage-table__disclosure'));
  assert.deepEqual([...coding().querySelectorAll('.usage-table__child .usage-table__name-main')].map((n) => n.textContent),
    ['claude-sonnet', 'gpt-5', 'mystery']);
  assert.equal(coding().querySelector('.usage-table__disclosure').getAttribute('aria-label'), 'Models in Coding');

  // Its chats carry their kind as a chip.
  ui.click(coding().querySelector('.usage-table__chats'));
  const chip = () => coding().querySelector('.usage-chats__item .usage-kind__chip');
  assert.equal(chip().textContent, 'Coding');
  assert.equal(chip().getAttribute('aria-haspopup'), 'listbox');
  assert.equal(chip().getAttribute('aria-label'), 'Kind of task of “Navigation”: Coding');

  // Opened, the six kinds with their meaning; the current one is selected and has the focus.
  chip().focus();
  ui.click(chip());
  const menu = ui.$('.usage-kind__menu');
  assert.equal(menu.getAttribute('role'), 'listbox');
  assert.equal(chip().getAttribute('aria-expanded'), 'true');
  const options = [...menu.querySelectorAll('[role="option"]')];
  assert.deepEqual(options.map((o) => o.querySelector('.usage-kind__option-name').textContent),
    ['Coding', 'Writing & editing', 'Research & questions', 'Data & analysis', 'Planning & concepts', 'Other']);
  assert.equal(ui.document.activeElement, options[0]);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  const key = (name) => ui.document.activeElement.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: name, bubbles: true }));
  key('ArrowDown');
  assert.equal(ui.document.activeElement, options[1]);
  key('End');
  assert.equal(ui.document.activeElement, options[5]);
  // Escape closes the menu, not the dialog, and gives the focus back to the chip.
  key('Escape');
  assert.equal(ui.$('.usage-kind__menu'), null);
  assert.equal(ui.dialog.isOpen(), true);
  assert.equal(ui.document.activeElement, chip());

  // Choosing stores the user's kind; the figures follow at once.
  ui.click(chip());
  ui.click(ui.$$('.usage-kind__menu [role="option"]')[1]);
  await ui.settle();
  await ui.settle();
  assert.deepEqual(stored, [['b', 'writing']]);
  // Cheapest first, as sorted above; Coding keeps only the chat without a price.
  assert.deepEqual(rowNames(ui.$$), ['Coding', 'Writing & editing', 'Planning & concepts', 'Unclassified']);
  assert.equal(ui.$('#usage-status').textContent, '“Navigation” now counts as Writing & editing.');
  assert.equal(ui.document.activeElement.dataset.focus, 'chats:taskKinds:coding', 'the focus stays in the row the chat left');

  // An unclassified chat invites a choice.
  const unclassified = () => ui.$$('#usage-table .usage-table__group').at(-1);
  ui.click(unclassified().querySelector('.usage-table__chats'));
  const none = unclassified().querySelector('.usage-kind__chip');
  assert.equal(none.textContent, 'Choose a kind');
  assert.equal(none.classList.contains('usage-kind__chip--none'), true);
  assert.equal(none.getAttribute('aria-label'), 'Kind of task of “Meeting notes”: not chosen yet');

  // A kind that is not stored says so and changes nothing.
  refuse = true;
  ui.click(none);
  ui.click(ui.$$('.usage-kind__menu [role="option"]')[3]);
  await ui.settle();
  assert.equal(ui.$('#usage-alert').textContent, 'The kind could not be stored. Try again.');
  assert.equal(rowNames(ui.$$).at(-1), 'Unclassified');
});

test('the kind chip shows in the other groupings too, and in German', async (t) => {
  const ui = await mount(t, {
    locale: 'de',
    getUsageReport: async (period) => buildUsageReport(CHATS.map((c) => ({ ...c, taskKind: { id: 'research', source: 'estimate', at: '2026-10-25T10:00:00.000Z' } })), period),
  });
  ui.dialog.open();
  await ui.settle();
  assert.deepEqual(ui.$$('input[name="usage-group"]').map((input) => input.closest('label').textContent.trim()), ['Modell', 'Workspace', 'Aufgabenart']);
  ui.click(ui.$('#usage-table .usage-table__chats'));
  assert.deepEqual(ui.$$('.usage-kind__chip').map((node) => node.textContent), ['Recherche & Fragen', 'Recherche & Fragen']);
  await ui.choose('usage-group', 'taskKinds');
  assert.deepEqual(rowNames(ui.$$), ['Recherche & Fragen']);
});
