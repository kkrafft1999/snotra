/**
 * The usage report (#1258): estimated cost and tokens across chats, per model
 * and per workspace, over a period.
 *
 * Pure functions only. Main builds the report from the history's index — each
 * entry carries its chat's `SessionCost` with day entries (cost.js), so no
 * chat file is opened — and the renderer resolves the period and draws.
 *
 * A period filters by the day the tokens were spent, not by when a chat was
 * made or last opened. Spending without a day — chats from before #1258 —
 * counts on the chat's last save (`costDaysOf`). Every day entry lands in
 * exactly one model row and one workspace row, so both views add up to the
 * same total.
 */
'use strict';

const { isRecord } = require('../runtime/is-record');
const { isMessage } = require('./message');
const { PRICE_SOURCES, costDaysOf, dayKeyOf, isDayKey } = require('./cost');

/** @typedef {import('./cost').CostTokens} CostTokens */
/** @typedef {import('./cost').CostDay} CostDay */
/** @typedef {import('./cost').PriceTableInfo} PriceTableInfo */

/** The periods the report offers, in display order. */
const USAGE_PERIODS = Object.freeze({
  LAST_7_DAYS: 'last7',
  LAST_30_DAYS: 'last30',
  THIS_MONTH: 'thisMonth',
  LAST_MONTH: 'lastMonth',
  ALL_TIME: 'all',
  CUSTOM: 'custom',
});

/** @typedef {typeof USAGE_PERIODS[keyof typeof USAGE_PERIODS]} UsagePeriodId */

/** The width of a bar in the chart. */
const USAGE_CHART_STEPS = Object.freeze({ DAY: 'day', WEEK: 'week', MONTH: 'month' });

/** Up to this many days the chart has a bar per day, up to a year one per week. */
const DAILY_BARS_MAX_DAYS = 62;
const WEEKLY_BARS_MAX_DAYS = 371;

/**
 * Sums of tokens and cost. `usd` is null while nothing in it could be priced
 * — never 0 for an unknown price. `local` says every round ran on the user's
 * own machine.
 *
 * @typedef {Object} UsageFigures
 * @property {CostTokens} tokens
 * @property {number|null} usd
 * @property {number} rounds
 * @property {number} unpricedRounds
 * @property {boolean} local
 */

/**
 * `providerName` is added by main, from the provider catalog.
 * @typedef {UsageFigures & { providerId: string, model: string, providerName?: string|import('./message').Message }} UsageModelPart
 * @typedef {UsageFigures & { workspaceRoot: string|null }} UsageWorkspacePart
 *
 * @typedef {UsageModelPart & { chats: number, workspaces: UsageWorkspacePart[] }} UsageModelRow
 * @typedef {UsageWorkspacePart & { chats: number, models: UsageModelPart[] }} UsageWorkspaceRow
 *
 * A chat with what it spent inside the period. `title` is its own title or
 * '', `untitled` the descriptor its row shows instead (#359). `lastDate` is
 * the last day inside the period it spent anything on.
 * @typedef {UsageFigures & { id: string, workspaceRoot: string|null, title: string,
 *   untitled?: import('./message').Message, lastDate: string,
 *   models: UsageModelPart[] }} UsageChatRow
 *
 * @typedef {Object} UsageDay
 * @property {string} date
 * @property {number|null} usd
 * @property {number} tokens  all kinds together
 *
 * @typedef {Object} UsageReport
 * @property {{ from: string|null, to: string|null }} period  as asked; null is open
 * @property {string|null} firstDate  the first day with spending in the period
 * @property {string|null} lastDate   the last one
 * @property {UsageFigures & { chats: number }} totals
 * @property {UsageModelRow[]} models          by cost, highest first
 * @property {UsageWorkspaceRow[]} workspaces  by cost, highest first
 * @property {UsageChatRow[]} chats            by cost, highest first
 * @property {UsageDay[]} days                 only days with spending, oldest first
 * @property {{ from: string, to: string }|null} priceTables  the oldest and newest price table the chats in it were priced with
 * @property {number} historyChats  how many chats the history holds
 * @property {boolean} historyFull  the history is at its limit; older chats are gone
 */

/**
 * An index entry as main keeps it — what the report reads of a chat.
 *
 * @typedef {Object} UsageChatInput
 * @property {string} id
 * @property {string|null} [workspaceRoot]
 * @property {string} [title]
 * @property {unknown} [untitled]
 * @property {number} [updatedAt]
 * @property {unknown} [cost]
 */

/** @returns {CostTokens} */
function emptyTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

/** @returns {UsageFigures} */
function emptyFigures() {
  return { tokens: emptyTokens(), usd: null, rounds: 0, unpricedRounds: 0, local: true };
}

/** @type {Array<keyof CostTokens>} */
const TOKEN_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];

/**
 * Adds a day entry to a sum in place.
 *
 * @param {UsageFigures} figures
 * @param {CostDay} day
 */
function addDay(figures, day) {
  for (const key of TOKEN_KEYS) figures.tokens[key] += day.tokens[key];
  if (day.usd) {
    const usd = day.usd.input + day.usd.cacheRead + day.usd.cacheWrite + day.usd.output;
    figures.usd = (figures.usd ?? 0) + usd;
  }
  figures.rounds += day.rounds;
  figures.unpricedRounds += day.unpricedRounds;
  if (day.priceSource !== PRICE_SOURCES.LOCAL || day.unpricedRounds > 0) figures.local = false;
}

/**
 * All tokens of a sum, every kind; reasoning is part of output and not added twice.
 *
 * @param {CostTokens} tokens
 */
function totalTokens(tokens) {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/**
 * Highest cost first; those without a price after every priced one, by tokens.
 *
 * @param {UsageFigures} a
 * @param {UsageFigures} b
 */
function byCost(a, b) {
  if (a.usd !== null && b.usd !== null && a.usd !== b.usd) return b.usd - a.usd;
  if (a.usd === null && b.usd !== null) return 1;
  if (a.usd !== null && b.usd === null) return -1;
  return totalTokens(b.tokens) - totalTokens(a.tokens);
}

/**
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {() => V} make
 * @returns {V}
 */
function upsert(map, key, make) {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

/**
 * The day `key` moved by `days`, as `YYYY-MM-DD`.
 *
 * @param {string} key
 * @param {number} days
 * @returns {string}
 */
function addDays(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  return /** @type {string} */ (dayKeyOf(new Date(year, month - 1, day + days).getTime()));
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {number} days from `from` to `to`, both counted
 */
function daysBetween(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  // UTC on purpose: a daylight-saving switch in between must not cost a day.
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
}

/**
 * The days a period covers, as `{ from, to }` with both days counted; null on
 * either side is open. `today` is the user's local day.
 *
 * @param {unknown} periodId
 * @param {{ today: string, from?: unknown, to?: unknown }} options
 * @returns {{ from: string|null, to: string|null }|null}  null for a custom range that is not one
 */
function resolveUsagePeriod(periodId, { today, from, to }) {
  if (!isDayKey(today)) return null;
  const [year, month] = today.split('-').map(Number);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  switch (periodId) {
    case USAGE_PERIODS.LAST_7_DAYS:
      return { from: addDays(today, -6), to: today };
    case USAGE_PERIODS.LAST_30_DAYS:
      return { from: addDays(today, -29), to: today };
    case USAGE_PERIODS.THIS_MONTH:
      return { from: `${year}-${pad(month)}-01`, to: today };
    case USAGE_PERIODS.LAST_MONTH: {
      const first = /** @type {string} */ (dayKeyOf(new Date(year, month - 2, 1).getTime()));
      const last = /** @type {string} */ (dayKeyOf(new Date(year, month - 1, 0).getTime()));
      return { from: first, to: last };
    }
    case USAGE_PERIODS.ALL_TIME:
      return { from: null, to: null };
    case USAGE_PERIODS.CUSTOM:
      return normalizeUsagePeriod({ from, to }, { requireBoth: true });
    default:
      return null;
  }
}

/**
 * A period as it arrives over IPC: days that exist or null, `from` not after
 * `to` (swapped when it is). With `requireBoth`, a side left open is no period.
 *
 * @param {unknown} raw
 * @param {{ requireBoth?: boolean }} [options]
 * @returns {{ from: string|null, to: string|null }|null}
 */
function normalizeUsagePeriod(raw, { requireBoth = false } = {}) {
  if (!isRecord(raw)) return requireBoth ? null : { from: null, to: null };
  const from = isDayKey(raw.from) ? raw.from : null;
  const to = isDayKey(raw.to) ? raw.to : null;
  if (requireBoth && (!from || !to)) return null;
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

/**
 * @param {string} date
 * @param {{ from: string|null, to: string|null }} period
 */
function inPeriod(date, period) {
  return (!period.from || date >= period.from) && (!period.to || date <= period.to);
}

/**
 * Builds the report from the history's index entries.
 *
 * @param {UsageChatInput[]} chats  every chat the history holds
 * @param {unknown} rawPeriod
 * @param {{ maxChats?: number }} [options]
 * @returns {UsageReport}
 */
function buildUsageReport(chats, rawPeriod, { maxChats = Infinity } = {}) {
  const period = /** @type {{ from: string|null, to: string|null }} */ (normalizeUsagePeriod(rawPeriod));
  const list = Array.isArray(chats) ? chats : [];
  const totals = { ...emptyFigures(), chats: 0 };
  /** @type {Map<string, UsageModelRow & { chatIds: Set<string>, byWorkspace: Map<string, UsageWorkspacePart> }>} */
  const models = new Map();
  /** @type {Map<string, UsageWorkspaceRow & { chatIds: Set<string>, byModel: Map<string, UsageModelPart> }>} */
  const workspaces = new Map();
  /** @type {UsageChatRow[]} */
  const chatRows = [];
  /** @type {Map<string, UsageDay>} */
  const days = new Map();
  /** @type {string[]} */
  const priceTableDates = [];

  for (const chat of list) {
    if (!isRecord(chat) || typeof chat.id !== 'string' || !chat.id) continue;
    const workspaceRoot = typeof chat.workspaceRoot === 'string' && chat.workspaceRoot ? chat.workspaceRoot : null;
    const wsKey = workspaceRoot ?? '';
    const fallbackDate = dayKeyOf(typeof chat.updatedAt === 'number' ? chat.updatedAt : 0);
    const inside = costDaysOf(chat.cost, fallbackDate).filter((day) => inPeriod(day.date, period));
    if (inside.length === 0) continue;

    /** @type {UsageChatRow & { byModel: Map<string, UsageModelPart> }} */
    const row = {
      ...emptyFigures(),
      id: chat.id,
      workspaceRoot,
      title: typeof chat.title === 'string' ? chat.title : '',
      lastDate: inside[0].date,
      models: [],
      byModel: new Map(),
    };
    if (!row.title && isMessage(chat.untitled)) row.untitled = chat.untitled;

    const ws = upsert(workspaces, wsKey, () => ({ ...emptyFigures(), workspaceRoot, chats: 0, models: [], chatIds: new Set(), byModel: new Map() }));
    ws.chatIds.add(chat.id);

    for (const day of inside) {
      const modelKey = `${day.providerId}\u0000${day.model}`;
      const model = upsert(models, modelKey, () => ({
        ...emptyFigures(), providerId: day.providerId, model: day.model, chats: 0, workspaces: [], chatIds: new Set(), byWorkspace: new Map(),
      }));
      model.chatIds.add(chat.id);
      addDay(model, day);
      addDay(upsert(model.byWorkspace, wsKey, () => ({ ...emptyFigures(), workspaceRoot })), day);
      addDay(ws, day);
      addDay(upsert(ws.byModel, modelKey, () => ({ ...emptyFigures(), providerId: day.providerId, model: day.model })), day);
      addDay(row, day);
      addDay(upsert(row.byModel, modelKey, () => ({ ...emptyFigures(), providerId: day.providerId, model: day.model })), day);
      addDay(totals, day);
      const perDay = upsert(days, day.date, () => ({ date: day.date, usd: null, tokens: 0 }));
      if (day.usd) perDay.usd = (perDay.usd ?? 0) + day.usd.input + day.usd.cacheRead + day.usd.cacheWrite + day.usd.output;
      perDay.tokens += totalTokens(day.tokens);
      if (day.date > row.lastDate) row.lastDate = day.date;
    }
    const { byModel, ...chatRow } = row;
    chatRow.models = [...byModel.values()].sort(byCost);
    chatRows.push(chatRow);
    totals.chats += 1;
    const priceTable = isRecord(chat.cost) && isRecord(chat.cost.priceTable) ? chat.cost.priceTable.date : null;
    if (isDayKey(priceTable)) priceTableDates.push(priceTable);
  }

  const modelRows = [...models.values()].map(({ chatIds, byWorkspace, ...model }) => ({
    ...model,
    chats: chatIds.size,
    workspaces: [...byWorkspace.values()].sort(byCost),
  })).sort(byCost);
  const workspaceRows = [...workspaces.values()].map(({ chatIds, byModel, ...ws }) => ({
    ...ws,
    chats: chatIds.size,
    models: [...byModel.values()].sort(byCost),
  })).sort(byCost);
  const dayRows = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  priceTableDates.sort();
  const historyChats = list.length;

  return {
    period,
    firstDate: dayRows[0]?.date ?? null,
    lastDate: dayRows[dayRows.length - 1]?.date ?? null,
    totals,
    models: modelRows,
    workspaces: workspaceRows,
    chats: chatRows.sort(byCost),
    days: dayRows,
    priceTables: priceTableDates.length > 0
      ? { from: priceTableDates[0], to: priceTableDates[priceTableDates.length - 1] }
      : null,
    historyChats,
    historyFull: historyChats >= maxChats,
  };
}

/**
 * @typedef {Object} UsageChartBar
 * @property {string} from  first day of the bar
 * @property {string} to    last day of the bar, inside the period
 * @property {number|null} usd
 * @property {number} tokens
 */

/**
 * The bars of the chart over `from`…`to`: one per day up to two months, one
 * per week (Monday to Sunday) up to a year, one per month beyond. Days
 * without spending are bars of nothing, so the time axis stays even.
 *
 * @param {UsageDay[]} days
 * @param {string|null} from
 * @param {string|null} to
 * @returns {{ step: typeof USAGE_CHART_STEPS[keyof typeof USAGE_CHART_STEPS], bars: UsageChartBar[] }}
 */
function usageChartBars(days, from, to) {
  if (!isDayKey(from) || !isDayKey(to) || from > to) return { step: USAGE_CHART_STEPS.DAY, bars: [] };
  const span = daysBetween(from, to);
  const step = span <= DAILY_BARS_MAX_DAYS
    ? USAGE_CHART_STEPS.DAY
    : span <= WEEKLY_BARS_MAX_DAYS ? USAGE_CHART_STEPS.WEEK : USAGE_CHART_STEPS.MONTH;
  /** @type {UsageChartBar[]} */
  const bars = [];
  let start = from;
  while (start <= to) {
    let end = start;
    if (step === USAGE_CHART_STEPS.WEEK) {
      const [y, m, d] = start.split('-').map(Number);
      const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday 0
      end = addDays(start, 6 - weekday);
    } else if (step === USAGE_CHART_STEPS.MONTH) {
      const [y, m] = start.split('-').map(Number);
      end = /** @type {string} */ (dayKeyOf(new Date(y, m, 0).getTime()));
    }
    if (end > to) end = to;
    bars.push({ from: start, to: end, usd: null, tokens: 0 });
    start = addDays(end, 1);
  }
  let index = 0;
  for (const day of [...(Array.isArray(days) ? days : [])].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (!isDayKey(day?.date) || day.date < from || day.date > to) continue;
    while (index < bars.length - 1 && day.date > bars[index].to) index += 1;
    const bar = bars[index];
    if (day.usd !== null && Number.isFinite(day.usd)) bar.usd = (bar.usd ?? 0) + day.usd;
    bar.tokens += Number(day.tokens) || 0;
  }
  return { step, bars };
}

module.exports = {
  USAGE_PERIODS,
  USAGE_CHART_STEPS,
  resolveUsagePeriod,
  normalizeUsagePeriod,
  buildUsageReport,
  usageChartBars,
};
