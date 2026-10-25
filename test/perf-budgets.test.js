const test = require('node:test');
const assert = require('node:assert/strict');
const { BUDGETS, timeFactor, median, max, evaluate, markdownTable } = require('../scripts/perf-budgets');

test('the budgets are the ones docs/architecture/quality-requirements.md agrees on (#984)', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(BUDGETS).map(([id, b]) => [id, `${b.limit} ${b.unit}`])),
    { 'PERF-1': '3000 ms', 'PERF-2': '200 ms', 'PERF-3': '500 ms', 'PERF-4': '1024 MB' },
  );
});

test('only a local Apple Silicon Mac is held to the plain time budgets', () => {
  assert.equal(timeFactor({ platform: 'darwin', arch: 'arm64', ci: false }), 1);
  assert.equal(timeFactor({ platform: 'darwin', arch: 'arm64', ci: true }), 2, 'a CI runner gets twice the time, even on Apple Silicon');
  assert.equal(timeFactor({ platform: 'darwin', arch: 'x64', ci: false }), 2);
  assert.equal(timeFactor({ platform: 'win32', arch: 'x64', ci: false }), 2);
  assert.equal(timeFactor({ platform: 'linux', arch: 'x64', ci: false }), 2);
});

test('the memory budget does not scale with the machine', () => {
  const rows = evaluate({ 'PERF-1': 5000, 'PERF-4': 1500 }, { platform: 'linux', arch: 'x64', ci: true });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId['PERF-1'].limit, 6000);
  assert.equal(byId['PERF-1'].ok, true);
  assert.equal(byId['PERF-4'].limit, 1024);
  assert.equal(byId['PERF-4'].ok, false);
});

test('a budget without a value is neither kept nor missed', () => {
  const rows = evaluate({ 'PERF-2': 200, 'PERF-3': Number.NaN }, { platform: 'darwin', arch: 'arm64', ci: false });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId['PERF-1'].ok, null);
  assert.equal(byId['PERF-2'].ok, true, 'the limit itself is still kept');
  assert.equal(byId['PERF-3'].value, null);
  assert.equal(byId['PERF-3'].ok, null);
});

test('median and max skip what was not measured', () => {
  assert.equal(median([300, 100, 200]), 200);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, Number.NaN]), null);
  assert.equal(max([1, null, 7, 3]), 7);
  assert.equal(max([]), null);
});

test('the table names every budget with its result', () => {
  const table = markdownTable(evaluate({ 'PERF-1': 1234.4, 'PERF-2': 900, 'PERF-4': 800 }, { platform: 'darwin', arch: 'arm64', ci: false }));
  assert.match(table, /\| PERF-1 \| .* \| 1,234 ms \| 3,000 ms \| ✅ kept \|/);
  assert.match(table, /\| PERF-2 \| .* \| 900 ms \| 200 ms \| ❌ missed \|/);
  assert.match(table, /\| PERF-3 \| .* \| — \| 500 ms \| ⚪ not measured \|/);
  assert.match(table, /\| PERF-4 \| .* \| 800 MB \| 1,024 MB \| ✅ kept \|/);
});
