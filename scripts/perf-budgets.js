'use strict';
/**
 * The performance budgets PERF-1 to PERF-4 of docs/architecture/quality-requirements.md and
 * how one measured run is held against them (#984). Kept apart from the
 * measurement in e2e/perf-report.mjs, which needs a running app, so that the
 * arithmetic — which machine gets which allowance, what counts as missed —
 * is covered by the unit suite.
 *
 * The budgets are stated for a current Apple Silicon Mac. "On Windows, Linux
 * and the CI runners twice the time is allowed" — twice the *time*: the memory
 * budget is the same everywhere.
 */

const BUDGETS = Object.freeze({
  'PERF-1': Object.freeze({ what: 'Cold start until folder and chat are restored', limit: 3000, unit: 'ms', scalesWithMachine: true }),
  'PERF-2': Object.freeze({ what: 'Reaction to typing and to a chat switch', limit: 200, unit: 'ms', scalesWithMachine: true }),
  'PERF-3': Object.freeze({ what: 'Longest frame while streaming or opening a large folder', limit: 500, unit: 'ms', scalesWithMachine: true }),
  'PERF-4': Object.freeze({ what: 'Idle memory across all processes', limit: 1024, unit: 'MB', scalesWithMachine: false }),
});

/** 1 on the reference machine, 2 everywhere else — CI runners included, an Apple Silicon one too. */
function timeFactor({ platform, arch, ci }) {
  return platform === 'darwin' && arch === 'arm64' && !ci ? 1 : 2;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function max(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

/**
 * One row per budget: the measured value, the limit for this machine and
 * whether it was kept. A value that is missing (null) was not measured — `ok`
 * is null then, which is neither a pass nor a miss.
 */
function evaluate(measured, machine) {
  const factor = timeFactor(machine);
  return Object.entries(BUDGETS).map(([id, budget]) => {
    const value = Number.isFinite(measured[id]) ? measured[id] : null;
    const limit = budget.scalesWithMachine ? budget.limit * factor : budget.limit;
    return { id, what: budget.what, value, limit, unit: budget.unit, ok: value === null ? null : value <= limit };
  });
}

function formatValue(value, unit) {
  return value === null ? '—' : `${Math.round(value).toLocaleString('en-US')} ${unit}`;
}

/** The table for the job summary and the console. */
function markdownTable(rows) {
  const mark = (ok) => (ok === null ? '⚪ not measured' : ok ? '✅ kept' : '❌ missed');
  const lines = [
    '| Budget | What | Measured | Limit here | Result |',
    '| --- | --- | ---: | ---: | --- |',
    ...rows.map((row) => `| ${row.id} | ${row.what} | ${formatValue(row.value, row.unit)} | ${formatValue(row.limit, row.unit)} | ${mark(row.ok)} |`),
  ];
  return lines.join('\n');
}

module.exports = { BUDGETS, timeFactor, median, max, evaluate, markdownTable };
