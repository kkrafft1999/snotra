/**
 * The usage report (#1258): estimated cost and tokens across chats, per model,
 * per workspace and per kind of task (#1283), over a period the user picks. Opened from the button at
 * the foot of the sidebar, from *View › Usage & Cost…* and with
 * Cmd/Ctrl+Shift+K.
 *
 * Main adds the figures up from the history's index (usage-report.js); this
 * file picks the period and draws: the totals, a bar per day (week, month)
 * over the period, and one table per dimension whose rows unfold in place —
 * a workspace or a kind of task into its models, a model into its
 * workspaces, and "n chats" into the chats behind the row, each of which
 * opens and shows its kind of task as a chip the user can change it with.
 *
 * Everything is an estimate and says so: `~` in front, `+` where requests
 * without a known price are left out, `–` — never $0.00 — for a model
 * without a price. A model on the user's own machine shows $0.00 and *local*.
 */

import contracts from '../generated/contracts.js';
import { getLocale, onLocaleChange, t, tMessage, tPlural } from '../i18n.js';
import { formatCostAmount } from './CostPanel.js';
import { formatTokensCompact } from '../utils/token-format.js';
import { svgChevron } from '../utils/helpers.js';

const {
  USAGE_PERIODS, USAGE_CHART_STEPS, TASK_KIND_IDS, dayKeyOf, formatUsd, isDayKey, resolveUsagePeriod, usageChartBars,
} = contracts;

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** A report that takes longer than this says it is loading. */
const LOADING_DELAY_MS = 200;
/** The most labels under the chart, beyond a few bars that are each labelled. */
const AXIS_LABELS = 5;
const LABEL_EVERY_BAR_UP_TO = 8;

const DIMENSIONS = Object.freeze({ MODELS: 'models', WORKSPACES: 'workspaces', TASK_KINDS: 'taskKinds' });
const SORT_KEYS = Object.freeze({ NAME: 'name', TOKENS: 'tokens', CHATS: 'chats', COST: 'cost' });

/** The caret of the kind chip, in the colour of its text. */
const CARET_SVG = '<svg class="usage-kind__caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path fill="currentColor" d="M0 0l5 6 5-6z"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Every kind of token once; reasoning is a part of output. */
function totalTokens(tokens) {
  return (tokens?.input || 0) + (tokens?.cacheRead || 0) + (tokens?.cacheWrite || 0) + (tokens?.output || 0);
}

function modelKey(part) {
  return `${part.providerId}\u0000${part.model}`;
}

function workspaceKey(part) {
  return part.workspaceRoot ?? '';
}

function taskKindKey(part) {
  return part.taskKind ?? '';
}

/** The last segment of a folder path, on either platform. */
function folderName(root) {
  const trimmed = String(root).replace(/[\\/]+$/, '');
  const name = trimmed.split(/[\\/]/).pop();
  return name || trimmed;
}

function sameRoot(a, b) {
  const strip = (value) => (value ? String(value).replace(/[\\/]+$/, '') : '');
  return strip(a) === strip(b);
}

/** A day key as a local Date, for the formatters. */
function dateOf(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * @param {object} deps
 * @param {object} deps.api                     the preload bridge
 * @param {() => string|null} deps.getActiveRoot  the folder open now
 * @param {(root: string) => Promise<boolean>} deps.openFolder
 * @param {(chatId: string) => Promise<void>} deps.openChat
 */
export function initUsageReportDialog({ api, getActiveRoot, openFolder, openChat }) {
  const root = document.getElementById('modal-usage');
  const dialog = root?.querySelector('.usage-dialog');
  if (!root || !dialog || typeof api?.getUsageReport !== 'function') {
    return { open: () => {}, isOpen: () => false };
  }
  const $ = (id) => document.getElementById(id);
  const backdrop = $('modal-usage-backdrop');
  const closeBtn = $('modal-usage-close');
  const doneBtn = $('usage-done');
  const periodInputs = Array.from(root.querySelectorAll('input[name="usage-period"]'));
  const rangeEl = $('usage-range');
  const customEl = $('usage-custom');
  const fromInput = $('usage-from');
  const toInput = $('usage-to');
  const alertEl = $('usage-alert');
  const statusEl = $('usage-status');
  const stateEl = $('usage-state');
  const reportEl = $('usage-report');
  const summaryEl = $('usage-summary');
  const chartEl = $('usage-chart');
  const groupInputs = Array.from(root.querySelectorAll('input[name="usage-group"]'));
  const tableEl = $('usage-table');
  const footnoteEl = $('usage-footnote');

  let periodId = USAGE_PERIODS.LAST_30_DAYS;
  /** The days of "Custom", kept while another period is picked. */
  let custom = { from: null, to: null };
  let dimension = DIMENSIONS.MODELS;
  /** Per dimension: which column sorts, which way. */
  const sorting = Object.fromEntries(Object.values(DIMENSIONS).map((dim) => [dim, { key: SORT_KEYS.COST, descending: true }]));
  /** Per dimension: rows unfolded, rows with their chats shown. */
  const expanded = Object.fromEntries(Object.values(DIMENSIONS).map((dim) => [dim, new Set()]));
  const chatsShown = Object.fromEntries(Object.values(DIMENSIONS).map((dim) => [dim, new Set()]));
  let chartAsTable = false;
  /** 'idle' | 'loading' | 'ready' | 'error' */
  let phase = 'idle';
  let report = null;
  let request = 0;
  let loadingTimer = null;
  let lastFocused = null;
  /** A chat that could not be opened, or a kind not stored: the key of the alert, and a folder. */
  let alert = null;
  /** The open kind menu (#1283): the chip it belongs to and the list. */
  let kindMenu = null;

  function isOpen() {
    return !root.classList.contains('hidden');
  }

  function today() {
    return dayKeyOf(Date.now());
  }

  /** The days asked for, or null while "Custom" lacks a day. */
  function currentPeriod() {
    return resolveUsagePeriod(periodId, { today: today(), from: custom.from, to: custom.to });
  }

  // ── Formatting ──────────────────────────────────────────────────────────

  /**
   * `~$1.23`, `~$1.23+`, `–`. Nothing is no estimate: a model on the user's
   * machine, or a day without spending, costs exactly $0.00.
   */
  function cost(figures) {
    if (figures.usd === 0 && figures.unpricedRounds === 0) return formatUsd(0, getLocale());
    return formatCostAmount({ usd: figures.usd, complete: figures.unpricedRounds === 0 });
  }

  function dayLabel(key, { year = false } = {}) {
    return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) })
      .format(dateOf(key));
  }

  function rangeLabel(from, to) {
    const format = new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
    if (from === to) return format.format(dateOf(from));
    return format.formatRange(dateOf(from), dateOf(to));
  }

  function monthLabel(key) {
    return new Intl.DateTimeFormat(getLocale(), { month: 'short', year: 'numeric' }).format(dateOf(key));
  }

  /** What a bar of the chart covers, as its label says it. */
  function barLabel(bar, step) {
    if (step === USAGE_CHART_STEPS.MONTH) return monthLabel(bar.from);
    if (step === USAGE_CHART_STEPS.WEEK) {
      return bar.from === bar.to ? dayLabel(bar.from) : new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short' })
        .formatRange(dateOf(bar.from), dateOf(bar.to));
    }
    return dayLabel(bar.from);
  }

  function percent(share) {
    if (share > 0 && share < 0.005) return t('usage.share.below', { percent: formatPercent(0.01) });
    return formatPercent(share);
  }

  function formatPercent(share) {
    return new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(share);
  }

  function providerLabel(part) {
    return part.providerName ? tMessage(part.providerName) : part.providerId;
  }

  function chatTitle(chat) {
    return chat.title || (chat.untitled ? tMessage(chat.untitled) : t('chat.title.new'));
  }

  /** What a row is called, and the line under its name. */
  function rowName(part, dim) {
    if (dim === DIMENSIONS.MODELS) return { name: part.model || part.providerId, sub: providerLabel(part), mono: true };
    if (dim === DIMENSIONS.TASK_KINDS) {
      if (part.taskKind === null) return { name: t('taskKind.unclassified'), sub: t('usage.taskKind.unclassified.hint'), mono: false };
      return { name: t(`taskKind.${part.taskKind}`), sub: t(`taskKind.${part.taskKind}.definition`), mono: false };
    }
    if (part.workspaceRoot === null) return { name: t('usage.noFolder'), sub: t('usage.noFolder.hint'), mono: false };
    return { name: folderName(part.workspaceRoot), sub: part.workspaceRoot, mono: false, path: true };
  }

  // ── Loading ─────────────────────────────────────────────────────────────

  /** What a click starts and nobody awaits: a failure still reaches the log. */
  function logFailure(error) {
    console.error('[usage]', error);
  }

  function reload() {
    load().catch(logFailure);
  }

  async function load() {
    const period = currentPeriod();
    if (!period) {
      draw();
      return;
    }
    const ticket = ++request;
    phase = phase === 'ready' ? 'ready' : 'loading';
    reportEl.setAttribute('aria-busy', 'true');
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => {
      if (ticket !== request) return;
      phase = 'loading';
      drawState();
    }, LOADING_DELAY_MS);
    let result = null;
    try {
      result = await api.getUsageReport(period);
    } catch (error) {
      // The dialog says so and offers to try again; the cause goes to the log.
      console.error('[usage] the report could not be loaded:', error);
      result = null;
    }
    if (ticket !== request) return;
    clearTimeout(loadingTimer);
    reportEl.removeAttribute('aria-busy');
    if (!result || !result.totals) {
      phase = 'error';
      report = null;
    } else {
      phase = 'ready';
      report = result;
    }
    draw();
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  /**
   * Rebuilds `container` and puts the focus back on the control that had it,
   * found again by its `data-focus` key.
   */
  function rebuild(container, build) {
    if (kindMenu && container.contains(kindMenu.list)) closeKindMenu({ restoreFocus: false });
    const active = document.activeElement;
    const key = active && container.contains(active) ? active.dataset?.focus : null;
    container.textContent = '';
    build(container);
    if (!key) return;
    const again = Array.from(container.querySelectorAll('[data-focus]')).find((node) => node.dataset.focus === key);
    again?.focus();
  }

  function draw() {
    drawPeriod();
    drawState();
    drawAlert();
    // The figures of the last period stay while the next one loads; a custom
    // range without both days shows none.
    const ready = phase !== 'error' && Boolean(currentPeriod()) && report?.totals.chats > 0;
    reportEl.hidden = !ready;
    if (ready) {
      rebuild(summaryEl, buildSummary);
      rebuild(chartEl, buildChart);
      for (const input of groupInputs) input.checked = input.value === dimension;
      rebuild(tableEl, buildTable);
    }
    drawFootnote();
  }

  function drawPeriod() {
    for (const input of periodInputs) input.checked = input.value === periodId;
    const isCustom = periodId === USAGE_PERIODS.CUSTOM;
    customEl.hidden = !isCustom;
    rangeEl.hidden = isCustom;
    if (isCustom) {
      fromInput.max = today();
      toInput.max = today();
      if (custom.from) fromInput.value = custom.from;
      if (custom.to) toInput.value = custom.to;
      return;
    }
    const period = currentPeriod();
    if (period?.from && period?.to) {
      rangeEl.textContent = rangeLabel(period.from, period.to);
    } else if (report?.firstDate && phase === 'ready') {
      rangeEl.textContent = t('usage.period.since', { date: dayLabel(report.firstDate, { year: true }) });
    } else {
      rangeEl.textContent = '';
    }
  }

  /** Loading, failed, nothing spent — or nothing, while there is a report. */
  function drawState() {
    stateEl.textContent = '';
    stateEl.removeAttribute('role');
    if (!isOpen()) return;
    if (periodId === USAGE_PERIODS.CUSTOM && !currentPeriod()) {
      stateEl.append(el('p', 'usage-dialog__state-title', t('usage.custom.incomplete')));
      return;
    }
    if (phase === 'loading' && !report) {
      stateEl.append(el('p', 'usage-dialog__state-hint', t('usage.loading')));
      return;
    }
    if (phase === 'error') {
      stateEl.setAttribute('role', 'alert');
      stateEl.append(el('p', 'usage-dialog__state-title', t('usage.error')));
      const retry = el('button', 'btn-secondary usage-dialog__retry', t('usage.retry'));
      retry.type = 'button';
      retry.addEventListener('click', reload);
      stateEl.append(retry);
      return;
    }
    if (phase === 'ready' && report && report.totals.chats === 0) {
      const all = periodId === USAGE_PERIODS.ALL_TIME;
      stateEl.append(
        el('p', 'usage-dialog__state-title', t(all ? 'usage.empty.all' : 'usage.empty.period')),
        el('p', 'usage-dialog__state-hint', t(all ? 'usage.empty.all.hint' : 'usage.empty.period.hint')),
      );
    }
  }

  function drawAlert() {
    alertEl.hidden = !alert;
    alertEl.textContent = alert ? t(alert.key, { path: alert.path }) : '';
  }

  function drawFootnote() {
    const full = report?.historyFull;
    footnoteEl.textContent = full
      ? t('usage.footnote.full', { max: report.historyChats })
      : t('usage.footnote');
  }

  function buildSummary(container) {
    const { totals } = report;
    const figure = (label, value, sub) => {
      const item = el('div', 'usage-dialog__total');
      item.append(el('dt', 'usage-dialog__total-label', label), el('dd', 'usage-dialog__total-value', value));
      if (sub) item.append(el('dd', 'usage-dialog__total-sub', sub));
      return item;
    };
    const list = el('dl', 'usage-dialog__totals');
    const tokens = totals.tokens;
    const folders = report.workspaces.filter((ws) => ws.workspaceRoot !== null).length;
    list.append(
      figure(t('usage.totals.cost'), cost(totals), tPlural('usage.totals.models', report.models.length, { count: report.models.length })),
      figure(t('usage.totals.tokens'), formatTokensCompact(totalTokens(tokens)), t('usage.totals.tokenSplit', {
        input: formatTokensCompact(tokens.input),
        cache: formatTokensCompact(tokens.cacheRead + tokens.cacheWrite),
        output: formatTokensCompact(tokens.output),
      })),
      figure(t('usage.totals.chats'), new Intl.NumberFormat(getLocale()).format(totals.chats),
        folders > 0 ? tPlural('usage.totals.workspaces', folders, { count: folders }) : null),
    );
    container.append(list);

    const note = el('p', 'usage-dialog__estimate');
    const tables = report.priceTables;
    let text = t('usage.estimate');
    if (tables && tables.from === tables.to) {
      text = t('usage.estimate.table', { date: dayLabel(tables.from, { year: true }) });
    } else if (tables) {
      text = t('usage.estimate.tables', { from: dayLabel(tables.from, { year: true }), to: dayLabel(tables.to, { year: true }) });
    }
    if (totals.unpricedRounds > 0) text = `${text} ${t('usage.estimate.partial')}`;
    note.textContent = text;
    container.append(note);
  }

  /** The days the chart spans: the period, or for "All time" from the first spending to today. */
  function chartRange() {
    const period = report.period;
    const from = period.from || report.firstDate;
    const to = period.to || today();
    return from && to ? { from, to } : null;
  }

  function buildChart(container) {
    const range = chartRange();
    if (!range) return;
    const { step, bars } = usageChartBars(report.days, range.from, range.to);
    if (bars.length === 0) return;
    // Cost while anything was priced; tokens when everything ran locally or had no price.
    const byCost = (report.totals.usd || 0) > 0;
    const value = (bar) => (byCost ? bar.usd || 0 : bar.tokens);
    const show = (bar) => (byCost ? cost({ usd: bar.usd, unpricedRounds: 0 }) : formatTokensCompact(bar.tokens));
    const titleKey = `usage.chart.${byCost ? 'cost' : 'tokens'}.${step}`;

    const head = el('div', 'usage-chart__head');
    const title = el('h3', 'usage-chart__title', t(titleKey));
    title.id = 'usage-chart-title';
    const toggle = el('button', 'usage-dialog__link usage-chart__toggle', t(chartAsTable ? 'usage.chart.showChart' : 'usage.chart.showTable'));
    toggle.type = 'button';
    toggle.dataset.focus = 'chart-toggle';
    toggle.addEventListener('click', () => {
      chartAsTable = !chartAsTable;
      rebuild(chartEl, buildChart);
    });
    head.append(title, toggle);
    container.append(head);

    if (chartAsTable) {
      container.append(buildChartTable(bars, step, show));
      return;
    }

    const max = Math.max(0, ...bars.map(value));
    const peak = bars.reduce((best, bar) => (value(bar) > value(best) ? bar : best), bars[0]);
    const plot = el('div', 'usage-chart__plot');
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', max > 0
      ? t('usage.chart.label', {
        title: t(titleKey),
        range: rangeLabel(range.from, range.to),
        value: show(peak),
        bar: barLabel(peak, step),
      })
      : t('usage.chart.labelEmpty', { title: t(titleKey), range: rangeLabel(range.from, range.to) }));
    const barsEl = el('div', 'usage-chart__bars');
    barsEl.setAttribute('aria-hidden', 'true');
    // Every bar has a slot of the same width, so the labels under them line up.
    for (const bar of bars) {
      const slot = el('span', 'usage-chart__slot');
      const item = el('span', 'usage-chart__bar');
      const v = value(bar);
      if (v <= 0) item.classList.add('usage-chart__bar--empty');
      else item.style.height = `${Math.max(2, (v / max) * 100)}%`;
      slot.title = `${barLabel(bar, step)}: ${v > 0 ? show(bar) : t('usage.chart.nothing')}`;
      slot.append(item);
      barsEl.append(slot);
    }
    plot.append(barsEl);
    container.append(plot);

    const axis = el('div', 'usage-chart__axis');
    axis.setAttribute('aria-hidden', 'true');
    // A few bars are each labelled; more get evenly spaced labels.
    const count = bars.length <= LABEL_EVERY_BAR_UP_TO ? bars.length : Math.min(AXIS_LABELS, bars.length);
    const indexes = new Set();
    for (let i = 0; i < count; i += 1) indexes.add(count === 1 ? 0 : Math.round((i * (bars.length - 1)) / (count - 1)));
    for (const index of indexes) {
      const label = el('span', 'usage-chart__tick', barLabel(bars[index], step === USAGE_CHART_STEPS.WEEK ? USAGE_CHART_STEPS.DAY : step));
      label.style.setProperty('--usage-tick-x', `${((index + 0.5) / bars.length) * 100}%`);
      if (index === 0) label.classList.add('usage-chart__tick--first');
      if (index === bars.length - 1) label.classList.add('usage-chart__tick--last');
      axis.append(label);
    }
    container.append(axis);
  }

  function buildChartTable(bars, step, show) {
    // It scrolls, so it takes the focus: the arrow keys scroll it (axe, WCAG 2.1.1).
    const wrap = el('div', 'usage-chart__table-wrap');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-labelledby', 'usage-chart-title');
    wrap.dataset.focus = 'chart-table';
    const table = el('table', 'usage-chart__table');
    table.setAttribute('aria-labelledby', 'usage-chart-title');
    const head = el('thead');
    const headRow = el('tr');
    for (const [key, numeric] of [[`usage.chart.column.${step}`, false], ['usage.column.cost', true], ['usage.column.tokens', true]]) {
      const th = el('th', numeric ? 'usage-table__num' : '', t(key));
      th.scope = 'col';
      headRow.append(th);
    }
    head.append(headRow);
    const body = el('tbody');
    for (const bar of bars) {
      const row = el('tr');
      const th = el('th', '', barLabel(bar, step));
      th.scope = 'row';
      row.append(
        th,
        // A bar of nothing spent is exactly $0.00; one without a price is unknown.
        el('td', 'usage-table__num', cost({ usd: bar.tokens === 0 ? 0 : bar.usd, unpricedRounds: 0 })),
        el('td', 'usage-table__num', formatTokensCompact(bar.tokens)),
      );
      body.append(row);
    }
    table.append(head, body);
    wrap.append(table);
    return wrap;
  }

  // ── The table ───────────────────────────────────────────────────────────

  function rowsOf(dim) {
    if (dim === DIMENSIONS.TASK_KINDS) return report.taskKinds ?? [];
    return dim === DIMENSIONS.MODELS ? report.models : report.workspaces;
  }

  function keyOf(part, dim) {
    if (dim === DIMENSIONS.TASK_KINDS) return taskKindKey(part);
    return dim === DIMENSIONS.MODELS ? modelKey(part) : workspaceKey(part);
  }

  /** What a table is called, and the head of its first column. */
  const TABLE_TEXT = {
    [DIMENSIONS.MODELS]: { caption: 'usage.table.caption.models', column: 'usage.column.model', expand: 'usage.row.expand.workspaces' },
    [DIMENSIONS.WORKSPACES]: { caption: 'usage.table.caption.workspaces', column: 'usage.column.workspace', expand: 'usage.row.expand.models' },
    [DIMENSIONS.TASK_KINDS]: { caption: 'usage.table.caption.taskKinds', column: 'usage.column.taskKind', expand: 'usage.row.expand.models' },
  };

  function sortRows(rows, dim) {
    const { key, descending } = sorting[dim];
    const direction = descending ? -1 : 1;
    const collator = new Intl.Collator(getLocale(), { sensitivity: 'base', numeric: true });
    const costOf = (row) => (row.usd === null ? -1 : row.usd);
    const compare = {
      [SORT_KEYS.NAME]: (a, b) => collator.compare(rowName(a, dim).name, rowName(b, dim).name),
      [SORT_KEYS.TOKENS]: (a, b) => totalTokens(a.tokens) - totalTokens(b.tokens),
      [SORT_KEYS.CHATS]: (a, b) => a.chats - b.chats,
      [SORT_KEYS.COST]: (a, b) => costOf(a) - costOf(b) || totalTokens(a.tokens) - totalTokens(b.tokens),
    }[key];
    // *Unclassified* is what is left over, whichever way the kinds sort (#1283).
    const last = (row) => (dim === DIMENSIONS.TASK_KINDS && row.taskKind === null ? 1 : 0);
    return [...rows].sort((a, b) => last(a) - last(b)
      || direction * compare(a, b)
      || collator.compare(rowName(a, dim).name, rowName(b, dim).name));
  }

  /** A row's share of the period: of the cost, or of the tokens when nothing had a price. */
  function shareOf(part) {
    const { totals } = report;
    if ((totals.usd || 0) > 0) return part.usd === null ? null : part.usd / totals.usd;
    const all = totalTokens(totals.tokens);
    return all > 0 ? totalTokens(part.tokens) / all : null;
  }

  function costCell(part) {
    const td = el('td', 'usage-table__num usage-table__cost');
    td.append(el('span', '', cost(part)));
    if (part.usd === null) td.append(el('span', 'usage-table__tag', t('usage.tag.unpriced')));
    else if (part.local && part.usd === 0) td.append(el('span', 'usage-table__tag', t('usage.tag.local')));
    return td;
  }

  function shareCell(part) {
    const td = el('td', 'usage-table__share');
    const share = shareOf(part);
    if (share === null) return td;
    const bar = el('span', 'usage-share');
    const track = el('span', 'usage-share__track');
    const fill = el('span', 'usage-share__fill');
    fill.style.width = `${Math.min(100, share * 100)}%`;
    track.append(fill);
    bar.append(track, el('span', 'usage-share__value', percent(share)));
    td.append(bar);
    return td;
  }

  function nameBlock(part, dim) {
    const { name, sub, mono, path } = rowName(part, dim);
    const block = el('span', 'usage-table__name');
    const main = el('span', `usage-table__name-main${mono ? ' usage-table__mono' : ''}`, name);
    main.title = name;
    const below = el('span', `usage-table__name-sub${path ? ' usage-table__mono' : ''}`, sub);
    below.title = sub;
    block.append(main, below);
    return block;
  }

  function sortHeader(label, sortKey, numeric) {
    const th = el('th', numeric ? 'usage-table__num' : '');
    th.scope = 'col';
    const sort = sorting[dimension];
    if (sort.key === sortKey) th.setAttribute('aria-sort', sort.descending ? 'descending' : 'ascending');
    const button = el('button', 'usage-table__sort');
    button.type = 'button';
    button.dataset.focus = `sort:${sortKey}`;
    // In a column of figures the arrow goes in front, so the label stays
    // flush with the figures under it.
    const arrow = el('span', 'usage-table__sort-arrow', sort.key === sortKey ? (sort.descending ? '↓' : '↑') : '');
    arrow.setAttribute('aria-hidden', 'true');
    if (numeric) button.append(arrow, el('span', '', label));
    else button.append(el('span', '', label), arrow);
    button.addEventListener('click', () => {
      const current = sorting[dimension];
      sorting[dimension] = current.key === sortKey
        ? { key: sortKey, descending: !current.descending }
        : { key: sortKey, descending: sortKey !== SORT_KEYS.NAME };
      rebuild(tableEl, buildTable);
    });
    th.append(button);
    return th;
  }

  function buildTable(container) {
    const dim = dimension;
    const table = el('table', 'usage-table');
    const caption = el('caption', 'visually-hidden', t(TABLE_TEXT[dim].caption));
    table.append(caption);
    const head = el('thead');
    const headRow = el('tr');
    const shareTh = el('th', 'usage-table__share', t('usage.column.share'));
    shareTh.scope = 'col';
    headRow.append(
      sortHeader(t(TABLE_TEXT[dim].column), SORT_KEYS.NAME, false),
      shareTh,
      sortHeader(t('usage.column.tokens'), SORT_KEYS.TOKENS, true),
      sortHeader(t('usage.column.chats'), SORT_KEYS.CHATS, true),
      sortHeader(t('usage.column.cost'), SORT_KEYS.COST, true),
    );
    head.append(headRow);
    table.append(head);

    sortRows(rowsOf(dim), dim).forEach((row, index) => {
      table.append(buildRowGroup(row, dim, index));
    });
    container.append(table);
  }

  /**
   * One row with what unfolds under it, in a body of its own: the other
   * dimension inside the row as rows of the same table — so their columns
   * line up —, its tokens by kind, and its chats.
   */
  function buildRowGroup(row, dim, index) {
    const key = keyOf(row, dim);
    const isExpanded = expanded[dim].has(key);
    const showChats = chatsShown[dim].has(key);
    const id = `usage-${dim}-${index}`;
    const other = dim === DIMENSIONS.MODELS ? DIMENSIONS.WORKSPACES : DIMENSIONS.MODELS;
    const parts = dim === DIMENSIONS.MODELS ? row.workspaces : row.models;
    const partIds = [...parts.map((_part, i) => `${id}-part-${i}`), `${id}-tokens`];
    const { name } = rowName(row, dim);
    const body = el('tbody', 'usage-table__group');

    const tr = el('tr', 'usage-table__row');
    const nameTh = el('th', 'usage-table__name-cell');
    nameTh.scope = 'row';
    const nameWrap = el('div', 'usage-table__name-wrap');
    const disclosure = el('button', 'usage-table__disclosure');
    disclosure.type = 'button';
    disclosure.innerHTML = svgChevron();
    disclosure.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    disclosure.setAttribute('aria-expanded', String(isExpanded));
    disclosure.setAttribute('aria-controls', partIds.join(' '));
    disclosure.setAttribute('aria-label', t(TABLE_TEXT[dim].expand, { name }));
    disclosure.dataset.focus = `expand:${dim}:${key}`;
    disclosure.addEventListener('click', () => {
      if (expanded[dim].has(key)) expanded[dim].delete(key);
      else expanded[dim].add(key);
      rebuild(tableEl, buildTable);
    });
    nameWrap.append(disclosure, nameBlock(row, dim));
    nameTh.append(nameWrap);
    const chatsTd = el('td', 'usage-table__num');
    const chatsBtn = el('button', 'usage-dialog__link usage-table__chats', tPlural('usage.row.chats', row.chats, { count: row.chats }));
    chatsBtn.type = 'button';
    chatsBtn.setAttribute('aria-expanded', String(showChats));
    chatsBtn.setAttribute('aria-controls', `${id}-chats`);
    chatsBtn.setAttribute('aria-label', tPlural('usage.row.chats.label', row.chats, { count: row.chats, name }));
    chatsBtn.dataset.focus = `chats:${dim}:${key}`;
    chatsBtn.addEventListener('click', () => {
      if (chatsShown[dim].has(key)) chatsShown[dim].delete(key);
      else chatsShown[dim].add(key);
      rebuild(tableEl, buildTable);
    });
    chatsTd.append(chatsBtn);
    tr.append(nameTh, shareCell(row), el('td', 'usage-table__num', formatTokensCompact(totalTokens(row.tokens))), chatsTd, costCell(row));
    body.append(tr);

    parts.forEach((part, i) => {
      const child = el('tr', 'usage-table__child');
      child.id = partIds[i];
      child.hidden = !isExpanded;
      const th = el('th', 'usage-table__name-cell usage-table__child-name');
      th.scope = 'row';
      th.append(nameBlock(part, other));
      child.append(th, shareCell(part), el('td', 'usage-table__num', formatTokensCompact(totalTokens(part.tokens))), el('td'), costCell(part));
      body.append(child);
    });
    const detail = el('tr', 'usage-table__detail');
    detail.id = partIds[partIds.length - 1];
    detail.hidden = !isExpanded;
    const detailTd = el('td', '', tokenBreakdown(row.tokens));
    detailTd.colSpan = 5;
    detail.append(detailTd);
    body.append(detail);

    const chatsRow = el('tr', 'usage-table__chats-row');
    chatsRow.id = `${id}-chats`;
    chatsRow.hidden = !showChats;
    const chatsCell = el('td');
    chatsCell.colSpan = 5;
    if (showChats) chatsCell.append(buildChats(row, dim));
    chatsRow.append(chatsCell);
    body.append(chatsRow);
    return body;
  }

  function tokenBreakdown(tokens) {
    const pieces = [t('usage.tokens.input', { count: formatTokensCompact(tokens.input) })];
    if (tokens.cacheRead > 0) pieces.push(t('usage.tokens.cacheRead', { count: formatTokensCompact(tokens.cacheRead) }));
    if (tokens.cacheWrite > 0) pieces.push(t('usage.tokens.cacheWrite', { count: formatTokensCompact(tokens.cacheWrite) }));
    pieces.push(tokens.reasoning > 0
      ? t('usage.tokens.outputWithReasoning', { count: formatTokensCompact(tokens.output), reasoning: formatTokensCompact(tokens.reasoning) })
      : t('usage.tokens.output', { count: formatTokensCompact(tokens.output) }));
    return pieces.join(' · ');
  }

  function buildChats(row, dim) {
    const key = keyOf(row, dim);
    const entries = dim === DIMENSIONS.MODELS
      ? report.chats
        .map((chat) => ({ chat, figures: chat.models.find((part) => modelKey(part) === key) }))
        .filter((entry) => entry.figures)
      : report.chats
        .filter((chat) => (dim === DIMENSIONS.TASK_KINDS ? taskKindKey(chat) : workspaceKey(chat)) === key)
        .map((chat) => ({ chat, figures: chat }));
    entries.sort((a, b) => (b.figures.usd ?? -1) - (a.figures.usd ?? -1) || totalTokens(b.figures.tokens) - totalTokens(a.figures.tokens));
    const wrap = el('div', 'usage-chats');
    const activeRoot = getActiveRoot();
    // A chat without a folder is shown only while no folder is open (#68).
    const unreachable = (chat) => chat.workspaceRoot === null && Boolean(activeRoot);
    if (entries.some(({ chat }) => unreachable(chat))) {
      wrap.append(el('p', 'usage-chats__note', t('usage.chats.noFolder')));
    }
    const list = el('ul', 'usage-chats__list');
    list.setAttribute('aria-label', t('usage.chats.list', { name: rowName(row, dim).name }));
    for (const { chat, figures } of entries) {
      const item = el('li', 'usage-chats__item');
      const title = chatTitle(chat);
      const text = el('span', 'usage-chats__text');
      const titleEl = el('span', 'usage-chats__title', title);
      titleEl.title = title;
      const meta = [];
      if (dim !== DIMENSIONS.WORKSPACES) meta.push(chat.workspaceRoot === null ? t('usage.noFolder') : folderName(chat.workspaceRoot));
      if (dim !== DIMENSIONS.MODELS) meta.push(chat.models.map((part) => part.model || part.providerId).join(', '));
      meta.push(t('usage.chats.lastUsed', { date: dayLabel(chat.lastDate) }));
      text.append(titleEl, el('span', 'usage-chats__meta', meta.join(' · ')));
      const amount = el('span', 'usage-chats__cost', cost(figures));
      item.append(text, kindControl(chat, `kind:${dim}:${key}:${chat.id}`), amount);
      if (!unreachable(chat)) {
        const open = el('button', 'btn-secondary usage-chats__open', t('usage.chats.open'));
        open.type = 'button';
        open.setAttribute('aria-label', t('usage.chats.open.label', { title }));
        open.dataset.focus = `open:${dim}:${key}:${chat.id}`;
        open.addEventListener('click', () => openReportedChat(chat).catch(logFailure));
        item.append(open);
      }
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  // ── The kind of a chat (#1283) ──────────────────────────────────────────

  function kindName(taskKind) {
    return taskKind ? t(`taskKind.${taskKind}`) : t('usage.taskKind.choose');
  }

  /** The chip that shows a chat's kind and opens the choice of the seven. */
  function kindControl(chat, focusKey) {
    const wrap = el('span', 'usage-kind');
    const chip = el('button', `usage-kind__chip${chat.taskKind ? '' : ' usage-kind__chip--none'}`);
    chip.type = 'button';
    chip.setAttribute('aria-haspopup', 'listbox');
    chip.setAttribute('aria-expanded', 'false');
    chip.setAttribute('aria-label', chat.taskKind
      ? t('usage.taskKind.label', { title: chatTitle(chat), kind: kindName(chat.taskKind) })
      : t('usage.taskKind.label.none', { title: chatTitle(chat) }));
    chip.dataset.focus = focusKey;
    chip.append(el('span', 'usage-kind__text', kindName(chat.taskKind)));
    chip.insertAdjacentHTML('beforeend', CARET_SVG);
    chip.addEventListener('click', () => {
      if (kindMenu?.chip === chip) closeKindMenu();
      else openKindMenu(chat, chip, wrap);
    });
    wrap.append(chip);
    return wrap;
  }

  function openKindMenu(chat, chip, wrap) {
    closeKindMenu({ restoreFocus: false });
    const list = el('ul', 'usage-kind__menu');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('usage.taskKind.menu', { title: chatTitle(chat) }));
    for (const id of TASK_KIND_IDS) {
      const li = el('li');
      li.setAttribute('role', 'none');
      const option = el('button', 'usage-kind__option');
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(id === chat.taskKind));
      const check = el('span', 'usage-kind__check', id === chat.taskKind ? '✓' : '');
      check.setAttribute('aria-hidden', 'true');
      const main = el('span', 'usage-kind__option-main');
      main.append(el('span', 'usage-kind__option-name', t(`taskKind.${id}`)), el('span', 'usage-kind__option-def', t(`taskKind.${id}.definition`)));
      option.append(check, main);
      option.addEventListener('click', () => chooseKind(chat, id).catch(logFailure));
      li.append(option);
      list.append(li);
    }
    list.addEventListener('keydown', (event) => {
      const options = Array.from(list.querySelectorAll('.usage-kind__option'));
      const index = options.indexOf(document.activeElement);
      let next = null;
      if (event.key === 'ArrowDown') next = options[(index + 1) % options.length];
      else if (event.key === 'ArrowUp') next = options[(index - 1 + options.length) % options.length];
      else if (event.key === 'Home') next = options[0];
      else if (event.key === 'End') next = options[options.length - 1];
      else if (event.key === 'Escape' || event.key === 'Tab') {
        // Escape closes the menu, not the dialog; Tab leaves it at its chip.
        event.preventDefault();
        event.stopPropagation();
        closeKindMenu();
        return;
      }
      if (!next) return;
      event.preventDefault();
      next.focus();
    });
    wrap.append(list);
    chip.setAttribute('aria-expanded', 'true');
    kindMenu = { chip, list };
    list.scrollIntoView?.({ block: 'nearest' });
    (list.querySelector('[aria-selected="true"]') || list.querySelector('.usage-kind__option'))?.focus();
  }

  function closeKindMenu({ restoreFocus = true } = {}) {
    if (!kindMenu) return;
    const { chip, list } = kindMenu;
    kindMenu = null;
    const hadFocus = list.contains(document.activeElement);
    list.remove();
    chip.setAttribute('aria-expanded', 'false');
    if (restoreFocus && hadFocus && chip.isConnected) chip.focus();
  }

  /**
   * Stores the user's choice and loads the report again, so every figure
   * follows at once. Grouped by kind, the chat moves to another row: the
   * focus goes to the chats of the row it left, or of the row it joined.
   */
  async function chooseKind(chat, id) {
    closeKindMenu();
    if (id === chat.taskKind) return;
    alert = null;
    drawAlert();
    let stored = null;
    try {
      stored = (await api.setChatTaskKind(chat.id, id))?.taskKind ?? null;
    } catch (error) {
      console.error('[usage] the kind could not be stored:', error);
      stored = null;
    }
    if (!stored) {
      alert = { key: 'usage.taskKind.failed' };
      drawAlert();
      return;
    }
    statusEl.textContent = t('usage.taskKind.changed', { title: chatTitle(chat), kind: t(`taskKind.${id}`) });
    const left = taskKindKey(chat);
    await load();
    if (!isOpen() || dialog.contains(document.activeElement)) return;
    const focusable = (focusKey) => tableEl.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
    (focusable(`chats:${DIMENSIONS.TASK_KINDS}:${left}`) || focusable(`chats:${DIMENSIONS.TASK_KINDS}:${id}`) || dialog)?.focus();
  }

  // ── Opening a chat ──────────────────────────────────────────────────────

  async function openReportedChat(chat) {
    alert = null;
    drawAlert();
    if (chat.workspaceRoot && !sameRoot(chat.workspaceRoot, getActiveRoot())) {
      let opened = false;
      try {
        opened = await openFolder(chat.workspaceRoot);
      } catch (error) {
        console.error('[usage] the chat\'s folder could not be opened:', error);
        opened = false;
      }
      if (!opened) {
        alert = { key: 'usage.chats.openFailed', path: chat.workspaceRoot };
        drawAlert();
        return;
      }
    }
    close({ restoreFocus: false });
    await openChat(chat.id);
    document.getElementById('chat-input')?.focus();
  }

  // ── Open and close ──────────────────────────────────────────────────────

  function open() {
    if (!isOpen()) {
      lastFocused = document.activeElement;
      root.classList.remove('hidden');
      root.setAttribute('aria-hidden', 'false');
    }
    alert = null;
    statusEl.textContent = '';
    draw();
    reload();
    (periodInputs.find((input) => input.checked) || periodInputs[0])?.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    closeKindMenu({ restoreFocus: false });
    request += 1;
    clearTimeout(loadingTimer);
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    const back = lastFocused;
    lastFocused = null;
    if (restoreFocus && back && back.isConnected) back.focus();
  }

  for (const input of periodInputs) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      if (input.value === USAGE_PERIODS.CUSTOM && (!custom.from || !custom.to)) {
        // "Custom" starts from the days shown so far, or the last 30.
        const previous = resolveUsagePeriod(periodId, { today: today() });
        const fallback = resolveUsagePeriod(USAGE_PERIODS.LAST_30_DAYS, { today: today() });
        custom = previous?.from && previous?.to ? { ...previous } : { ...fallback };
      }
      periodId = input.value;
      reload();
    });
  }
  for (const input of [fromInput, toInput]) {
    input.addEventListener('change', () => {
      custom = {
        from: isDayKey(fromInput.value) ? fromInput.value : null,
        to: isDayKey(toInput.value) ? toInput.value : null,
      };
      reload();
    });
  }
  for (const input of groupInputs) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      dimension = input.value;
      rebuild(tableEl, buildTable);
    });
  }
  doneBtn.addEventListener('click', () => close());
  closeBtn.addEventListener('click', () => close());
  backdrop?.addEventListener('click', () => close());
  // A click beside the open kind menu closes it, and lands where it was aimed.
  root.addEventListener('mousedown', (event) => {
    if (kindMenu && !kindMenu.chip.parentElement?.contains(event.target)) closeKindMenu({ restoreFocus: false });
  });

  // Focus cage: Tab runs in a circle inside the dialog, Escape closes it.
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(dialog.querySelectorAll(FOCUSABLE))
      .filter((node) => !node.disabled && !node.closest('[hidden]') && !node.closest('.hidden')
        && !(node.type === 'radio' && !node.checked));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  api.onOpenUsageReport?.(() => open());

  onLocaleChange(() => {
    if (isOpen()) draw();
  });

  return { open, isOpen };
}
