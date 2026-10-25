const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isDayKey,
  dayKeyOf,
  datedSessionCost,
  costDaysOf,
  withCostDays,
  mergeSessionCost,
  normalizeSessionCost,
} = require('../src/shared/contracts/cost');
const {
  USAGE_PERIODS,
  USAGE_CHART_STEPS,
  resolveUsagePeriod,
  normalizeUsagePeriod,
  buildUsageReport,
  usageChartBars,
} = require('../src/shared/contracts/usage-report');

// The usage report (#1258): spending by day in the chat's cost, and the sums
// over a period built from it.

const NOON = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

/** One model's spending, as a turn's cost carries it. */
function entry({ providerId = 'openai', model = 'gpt-x', input = 1000, output = 100, usd = 0.01, rounds = 1, unpricedRounds = 0, priceSource = 'table' } = {}) {
  return {
    providerId,
    model,
    tokens: { input, cacheRead: 0, cacheWrite: 0, output, reasoning: 0 },
    usd: usd === null ? null : { input: usd / 2, cacheRead: 0, cacheWrite: 0, output: usd / 2 },
    priceSource: usd === null ? null : priceSource,
    rounds,
    unpricedRounds: usd === null ? rounds : unpricedRounds,
  };
}

const turnCost = (...models) => ({ models, priceTable: { date: '2026-10-15', origin: 'bundled' } });

/** A chat as the index holds it, with its turns booked on the days given. */
function chat(id, turns, { workspaceRoot = '/work/a', updatedAt = NOON(2026, 10, 25), title = id } = {}) {
  let cost = null;
  for (const [date, ...models] of turns) cost = mergeSessionCost(cost, datedSessionCost(turnCost(...models), date));
  return { id, workspaceRoot, title, updatedAt, cost };
}

const usd = (figures) => Math.round((figures.usd ?? NaN) * 1e6) / 1e6;

// ── Day keys and day entries ───────────────────────────────────────────────

test('day keys are local calendar days that exist', () => {
  assert.equal(isDayKey('2026-10-25'), true);
  assert.equal(isDayKey('2026-02-29'), false, 'not a leap year');
  assert.equal(isDayKey('2028-02-29'), true);
  assert.equal(isDayKey('2026-13-01'), false);
  assert.equal(isDayKey('26-10-25'), false);
  assert.equal(isDayKey(20261025), false);
  assert.equal(dayKeyOf(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05', 'the local day, not UTC');
  assert.equal(dayKeyOf(Number.NaN), null);
});

test('a turn is booked on its day, and turns on the same day and model add up', () => {
  const first = datedSessionCost(turnCost(entry()), '2026-10-20');
  assert.deepEqual(first.days.map((d) => [d.date, d.model, d.rounds]), [['2026-10-20', 'gpt-x', 1]]);
  const sum = mergeSessionCost(
    mergeSessionCost(first, datedSessionCost(turnCost(entry()), '2026-10-20')),
    datedSessionCost(turnCost(entry(), entry({ model: 'gpt-y' })), '2026-10-22'),
  );
  assert.deepEqual(sum.days.map((d) => [d.date, d.model, d.rounds]), [
    ['2026-10-20', 'gpt-x', 2],
    ['2026-10-22', 'gpt-x', 1],
    ['2026-10-22', 'gpt-y', 1],
  ]);
  assert.deepEqual(sum.models.map((m) => [m.model, m.rounds]), [['gpt-x', 3], ['gpt-y', 1]], 'the totals as before #1258');
});

test('a stored day entry without a valid day is dropped, the rest of the cost stays', () => {
  const cost = normalizeSessionCost({
    models: [entry()],
    days: [{ ...entry(), date: '2026-02-30' }, { ...entry(), date: 'yesterday' }, { ...entry(), date: '2026-10-01' }],
  });
  assert.deepEqual(cost.days.map((d) => d.date), ['2026-10-01']);
  assert.equal(normalizeSessionCost({ models: [], days: [{ ...entry(), date: '2026-10-01' }] }), null);
});

test('spending without a day counts on the fallback day: all of an old chat, the rest of a mixed one', () => {
  // Saved before #1258: a total, no days.
  const old = normalizeSessionCost(turnCost(entry({ rounds: 3, usd: 0.03 })));
  assert.equal(old.days, undefined);
  const days = costDaysOf(old, '2026-09-01');
  assert.deepEqual(days.map((d) => [d.date, d.rounds]), [['2026-09-01', 3]]);
  assert.equal(usd({ usd: days[0].usd.input + days[0].usd.output }), 0.03);

  // An older release went on with a chat that had days: its turn has none.
  const mixed = mergeSessionCost(withCostDays(old, '2026-09-01'), turnCost(entry({ usd: 0.01 })));
  const covered = costDaysOf(mixed, '2026-10-05');
  assert.deepEqual(covered.map((d) => [d.date, d.rounds]), [['2026-09-01', 3], ['2026-10-05', 1]]);

  // Fully covered: nothing is added.
  const dated = datedSessionCost(turnCost(entry()), '2026-10-01');
  assert.deepEqual(costDaysOf(dated, '2026-10-25').map((d) => d.date), ['2026-10-01']);
});

test('an unpriced remainder stays unpriced, never free', () => {
  const old = normalizeSessionCost(turnCost(entry({ model: 'mystery', usd: null, rounds: 2 })));
  const [day] = costDaysOf(old, '2026-09-01');
  assert.equal(day.usd, null);
  assert.equal(day.unpricedRounds, 2);
});

// ── Periods ────────────────────────────────────────────────────────────────

test('the presets resolve against the local day, both ends counted', () => {
  const today = '2026-10-25';
  assert.deepEqual(resolveUsagePeriod(USAGE_PERIODS.LAST_7_DAYS, { today }), { from: '2026-10-19', to: today });
  assert.deepEqual(resolveUsagePeriod(USAGE_PERIODS.LAST_30_DAYS, { today }), { from: '2026-09-26', to: today });
  assert.deepEqual(resolveUsagePeriod(USAGE_PERIODS.THIS_MONTH, { today }), { from: '2026-10-01', to: today });
  assert.deepEqual(resolveUsagePeriod(USAGE_PERIODS.LAST_MONTH, { today }), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(resolveUsagePeriod(USAGE_PERIODS.LAST_MONTH, { today: '2027-01-10' }), { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual(resolveUsagePeriod(USAGE_PERIODS.LAST_MONTH, { today: '2028-03-31' }), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(resolveUsagePeriod(USAGE_PERIODS.ALL_TIME, { today }), { from: null, to: null });
  // Over the switch to summer time a week still has seven days.
  assert.deepEqual(resolveUsagePeriod(USAGE_PERIODS.LAST_7_DAYS, { today: '2026-03-31' }), { from: '2026-03-25', to: '2026-03-31' });
});

test('a custom range needs both days; reversed days are put in order', () => {
  const today = '2026-10-25';
  assert.deepEqual(resolveUsagePeriod(USAGE_PERIODS.CUSTOM, { today, from: '2026-10-10', to: '2026-10-01' }), { from: '2026-10-01', to: '2026-10-10' });
  assert.equal(resolveUsagePeriod(USAGE_PERIODS.CUSTOM, { today, from: '2026-10-10', to: '' }), null);
  assert.equal(resolveUsagePeriod('fortnight', { today }), null);
  // Over IPC an open side stays open, anything that is not a day is open too.
  assert.deepEqual(normalizeUsagePeriod({ from: '2026-10-01', to: 'later' }), { from: '2026-10-01', to: null });
  assert.deepEqual(normalizeUsagePeriod(null), { from: null, to: null });
});

// ── The report ─────────────────────────────────────────────────────────────

test('a period takes what was spent inside it — both ends included — not the chat as a whole', () => {
  const long = chat('long', [
    ['2026-09-30', entry({ usd: 1 })],
    ['2026-10-01', entry({ usd: 2 })],
    ['2026-10-07', entry({ usd: 4 })],
    ['2026-10-08', entry({ usd: 8 })],
  ]);
  const report = buildUsageReport([long], { from: '2026-10-01', to: '2026-10-07' });
  assert.equal(usd(report.totals), 6);
  assert.equal(report.totals.rounds, 2);
  assert.equal(report.totals.chats, 1);
  assert.deepEqual(report.days.map((d) => d.date), ['2026-10-01', '2026-10-07']);
  assert.equal(report.chats[0].lastDate, '2026-10-07', 'the last day inside the period');
  assert.equal(report.firstDate, '2026-10-01');

  assert.equal(buildUsageReport([long], { from: '2026-11-01', to: '2026-11-30' }).totals.chats, 0);
  assert.equal(usd(buildUsageReport([long], { from: null, to: null }).totals), 15);
});

test('a model switch inside a chat keeps both models, and the chat counts once', () => {
  const switched = chat('switched', [
    ['2026-10-02', entry({ model: 'gpt-x', usd: 1 })],
    ['2026-10-03', entry({ providerId: 'anthropic', model: 'claude-y', usd: 3 })],
  ]);
  const report = buildUsageReport([switched], { from: null, to: null });
  assert.deepEqual(report.models.map((m) => [m.model, usd(m), m.chats]), [['claude-y', 3, 1], ['gpt-x', 1, 1]]);
  assert.equal(report.totals.chats, 1);
  assert.deepEqual(report.chats[0].models.map((m) => m.model), ['claude-y', 'gpt-x']);
  assert.equal(usd(report.chats[0]), 4);
});

test('every dimension adds up to the same total', () => {
  const chats = [
    chat('a', [['2026-10-02', entry({ usd: 1.25 }), entry({ model: 'gpt-y', usd: 0.5 })]], { workspaceRoot: '/work/a' }),
    chat('b', [['2026-10-04', entry({ usd: 2 })], ['2026-10-05', entry({ model: 'local-z', providerId: 'ollama', usd: 0, priceSource: 'local' })]], { workspaceRoot: '/work/b' }),
    chat('c', [['2026-10-06', entry({ model: 'mystery', usd: null })]], { workspaceRoot: null }),
  ];
  const report = buildUsageReport(chats, { from: null, to: null });
  const sum = (rows, pick) => Math.round(rows.reduce((acc, row) => acc + pick(row), 0) * 1e6) / 1e6;
  assert.equal(sum(report.models, (m) => m.usd ?? 0), usd(report.totals));
  assert.equal(sum(report.workspaces, (w) => w.usd ?? 0), usd(report.totals));
  assert.equal(sum(report.chats, (c) => c.usd ?? 0), usd(report.totals));
  assert.equal(sum(report.days, (d) => d.usd ?? 0), usd(report.totals));
  const tokens = (rows) => rows.reduce((acc, row) => acc + row.tokens.input + row.tokens.output, 0);
  assert.equal(tokens(report.models), tokens(report.workspaces));
  assert.equal(tokens(report.models), report.totals.tokens.input + report.totals.tokens.output);
  // Each row unfolds into the other dimension, adding up to the row.
  for (const ws of report.workspaces) assert.equal(sum(ws.models, (m) => m.usd ?? 0), usd({ usd: ws.usd ?? 0 }));
  for (const model of report.models) assert.equal(sum(model.workspaces, (w) => w.rounds), model.rounds);
});

test('an unknown price is null, never 0; a local model is 0 and local; the total says it is partial', () => {
  const chats = [
    chat('priced', [['2026-10-02', entry({ usd: 2 })]]),
    chat('unknown', [['2026-10-02', entry({ model: 'mystery', usd: null, rounds: 2 })]]),
    chat('local', [['2026-10-02', entry({ providerId: 'ollama', model: 'qwen', usd: 0, priceSource: 'local' })]]),
  ];
  const report = buildUsageReport(chats, { from: null, to: null });
  const byModel = Object.fromEntries(report.models.map((m) => [m.model, m]));
  assert.equal(byModel.mystery.usd, null);
  assert.equal(byModel.mystery.unpricedRounds, 2);
  assert.equal(byModel.mystery.local, false);
  assert.equal(byModel.qwen.usd, 0);
  assert.equal(byModel.qwen.local, true);
  assert.equal(byModel['gpt-x'].local, false);
  assert.equal(usd(report.totals), 2);
  assert.equal(report.totals.unpricedRounds, 2);
  assert.equal(report.models.at(-1).model, 'mystery', 'without a price after every priced row');

  const onlyUnknown = buildUsageReport([chats[1]], { from: null, to: null });
  assert.equal(onlyUnknown.totals.usd, null);
});

test('chats without a folder are a group of their own, never dropped', () => {
  const report = buildUsageReport([
    chat('loose', [['2026-10-02', entry({ usd: 1 })]], { workspaceRoot: null }),
    chat('empty-string', [['2026-10-02', entry({ usd: 1 })]], { workspaceRoot: '' }),
    chat('kept', [['2026-10-02', entry({ usd: 3 })]], { workspaceRoot: '/work/a' }),
  ], { from: null, to: null });
  assert.deepEqual(report.workspaces.map((w) => [w.workspaceRoot, usd(w), w.chats]), [['/work/a', 3, 1], [null, 2, 2]]);
  assert.equal(report.chats.find((c) => c.id === 'loose').workspaceRoot, null);
});

test('a chat saved before the day entries counts in full on its last save', () => {
  const old = { id: 'old', workspaceRoot: '/work/a', title: 'Old', updatedAt: NOON(2026, 9, 12), cost: turnCost(entry({ usd: 5, rounds: 4 })) };
  assert.equal(buildUsageReport([old], { from: '2026-09-12', to: '2026-09-12' }).totals.rounds, 4);
  assert.equal(buildUsageReport([old], { from: '2026-09-13', to: '2026-10-25' }).totals.chats, 0);
  // A broken cost or no cost at all is no spending, not an error.
  const report = buildUsageReport([{ id: 'none', updatedAt: NOON(2026, 9, 12) }, { id: 'junk', cost: { models: 'x' } }, null, { title: 'no id' }], { from: null, to: null });
  assert.equal(report.totals.chats, 0);
  assert.equal(report.historyChats, 4);
});

test('a deleted chat is no longer there to count', () => {
  const chats = [chat('a', [['2026-10-02', entry({ usd: 1 })]]), chat('b', [['2026-10-02', entry({ usd: 2 })]])];
  assert.equal(usd(buildUsageReport(chats, { from: null, to: null }).totals), 3);
  assert.equal(usd(buildUsageReport(chats.filter((c) => c.id !== 'b'), { from: null, to: null }).totals), 1);
});

test('the report names the chat, its descriptor when it has no title, and the price tables used', () => {
  const titled = chat('titled', [['2026-10-02', entry()]], { title: 'Plan the release' });
  const untitled = { ...chat('untitled', [['2026-10-03', entry()]], { title: '' }), untitled: { key: 'chat.title.new' } };
  untitled.cost = { ...untitled.cost, priceTable: { date: '2026-09-01', origin: 'downloaded' } };
  const report = buildUsageReport([titled, untitled], { from: null, to: null }, { maxChats: 2 });
  const byId = Object.fromEntries(report.chats.map((c) => [c.id, c]));
  assert.equal(byId.titled.title, 'Plan the release');
  assert.equal(byId.titled.untitled, undefined);
  assert.deepEqual(byId.untitled.untitled, { key: 'chat.title.new' });
  assert.deepEqual(report.priceTables, { from: '2026-09-01', to: '2026-10-15' });
  assert.equal(report.historyFull, true, 'the history is at its limit');
  assert.equal(buildUsageReport([titled], { from: null, to: null }, { maxChats: 200 }).historyFull, false);
});

test('a history of 1,000 chats is added up from the index in well under a second', () => {
  const chats = [];
  for (let i = 0; i < 1000; i += 1) {
    const turns = [];
    for (let d = 1; d <= 30; d += 1) turns.push([`2026-09-${String(d).padStart(2, '0')}`, entry({ model: `m${i % 7}`, usd: 0.01 })]);
    chats.push(chat(`c${i}`, turns, { workspaceRoot: `/work/${i % 12}` }));
  }
  const started = performance.now();
  const report = buildUsageReport(chats, { from: '2026-09-10', to: '2026-09-19' });
  const elapsed = performance.now() - started;
  assert.equal(report.totals.chats, 1000);
  assert.equal(report.totals.rounds, 10_000);
  assert.equal(report.models.length, 7);
  assert.equal(report.workspaces.length, 12);
  assert.ok(elapsed < 1500, `took ${Math.round(elapsed)} ms`);
});

// ── The chart ──────────────────────────────────────────────────────────────

test('the chart has a bar per day up to two months, nothing-days included', () => {
  const { step, bars } = usageChartBars([
    { date: '2026-10-02', usd: 1.5, tokens: 100 },
    { date: '2026-10-02', usd: 0.5, tokens: 50 },
    { date: '2026-10-05', usd: null, tokens: 70 },
    { date: '2026-11-01', usd: 9, tokens: 1 },
  ], '2026-10-01', '2026-10-30');
  assert.equal(step, USAGE_CHART_STEPS.DAY);
  assert.equal(bars.length, 30);
  assert.deepEqual(bars[1], { from: '2026-10-02', to: '2026-10-02', usd: 2, tokens: 150 });
  assert.deepEqual(bars[4], { from: '2026-10-05', to: '2026-10-05', usd: null, tokens: 70 }, 'tokens without a price stay unpriced');
  assert.equal(bars[2].usd, null);
  assert.equal(bars.reduce((acc, bar) => acc + bar.tokens, 0), 220, 'a day outside the range is not drawn');
});

test('longer ranges get a bar per week (Monday to Sunday), then per month', () => {
  const weekly = usageChartBars([{ date: '2026-07-06', usd: 1, tokens: 1 }, { date: '2026-07-12', usd: 2, tokens: 1 }], '2026-07-01', '2026-10-25');
  assert.equal(weekly.step, USAGE_CHART_STEPS.WEEK);
  assert.deepEqual(weekly.bars[0], { from: '2026-07-01', to: '2026-07-05', usd: null, tokens: 0 }, 'the first week starts mid-week');
  assert.deepEqual(weekly.bars[1], { from: '2026-07-06', to: '2026-07-12', usd: 3, tokens: 2 });
  assert.equal(weekly.bars.at(-1).to, '2026-10-25');

  const monthly = usageChartBars([{ date: '2025-02-14', usd: 1, tokens: 1 }], '2025-01-15', '2026-10-25');
  assert.equal(monthly.step, USAGE_CHART_STEPS.MONTH);
  assert.deepEqual(monthly.bars[0], { from: '2025-01-15', to: '2025-01-31', usd: null, tokens: 0 });
  assert.deepEqual(monthly.bars[1], { from: '2025-02-01', to: '2025-02-28', usd: 1, tokens: 1 });
  assert.equal(monthly.bars.length, 22);

  assert.deepEqual(usageChartBars([], null, '2026-10-25'), { step: USAGE_CHART_STEPS.DAY, bars: [] });
});
