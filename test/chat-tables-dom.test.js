// Tables in a chat answer (#961): every table gets a frame that scrolls
// sideways, and a column of numbers is aligned right unless the Markdown set
// an alignment of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

let dom = null;
let tables = null;

test.before(async () => {
  dom = setupRendererDom();
  tables = await importRenderer('chat', 'chatTables.js');
});

test.after(() => dom?.cleanup());

function render(html) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return tables.prepareChatTables(root);
}

function numericColumns(root) {
  return [...root.querySelectorAll('thead th')].map((th) => th.classList.contains('chat-cell--num'));
}

test('numbers as people write them count as numbers', () => {
  for (const text of ['7', '7 412', '1.234.567', '1,288', "12'000", '3,5', '-4.2', '−4', '12 %', '480 ms', '€ 12', '1,2 MB']) {
    assert.equal(tables.isNumericCell(text), true, text);
  }
});

test('dates, versions and words do not', () => {
  for (const text of ['14.10.2026', '2026-10-15', '1.22.0', 'v1.2', '#42', 'styles.css', '12 Zeilen', '']) {
    assert.equal(tables.isNumericCell(text), false, text);
  }
});

test('every table is put in a scrolling frame', () => {
  const root = render('<p>x</p><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table>');
  const table = root.querySelector('table');
  assert.equal(table.parentElement.className, 'chat-table-frame');
  assert.equal(root.children.length, 2);
});

test('a column of numbers is marked in head and body, others are not', () => {
  const root = render(`<table>
    <thead><tr><th>File</th><th>Lines</th><th>Changed</th></tr></thead>
    <tbody>
      <tr><td>styles.css</td><td>7 412</td><td>14.10.2026</td></tr>
      <tr><td>ChatView.js</td><td>—</td><td>12.10.2026</td></tr>
      <tr><td>view.js</td><td>604</td><td>09.10.2026</td></tr>
    </tbody></table>`);
  assert.deepEqual(numericColumns(root), [false, true, false]);
  const lines = [...root.querySelectorAll('tbody tr')].map((tr) => tr.cells[1].classList.contains('chat-cell--num'));
  assert.deepEqual(lines, [true, true, true]);
});

test('a column with only blanks, or one word among numbers, stays left', () => {
  const root = render(`<table>
    <thead><tr><th>A</th><th>B</th></tr></thead>
    <tbody><tr><td>-</td><td>12</td></tr><tr><td></td><td>many</td></tr></tbody></table>`);
  assert.deepEqual(numericColumns(root), [false, false]);
});

test('an alignment from the Markdown wins', () => {
  const root = render(`<table>
    <thead><tr><th align="center">A</th><th style="text-align: left">B</th></tr></thead>
    <tbody><tr><td align="center">1</td><td style="text-align: left">2</td></tr></tbody></table>`);
  assert.deepEqual(numericColumns(root), [false, false]);
});

test('short values keep their line, a column of sentences keeps a width', () => {
  const root = render(`<table>
    <thead><tr><th>Date</th><th>Purpose</th></tr></thead>
    <tbody>
      <tr><td>14.10.2026</td><td>Every style of the interface, including chat, tree and dialogs</td></tr>
      <tr><td>12.10.2026</td><td>Short</td></tr>
    </tbody></table>`);
  const [first, second] = root.querySelectorAll('tbody tr');
  assert.equal(first.cells[0].classList.contains('chat-cell--short'), true);
  assert.equal(first.cells[1].classList.contains('chat-cell--short'), false);
  assert.equal(second.cells[1].classList.contains('chat-cell--short'), true);
  const prose = [...root.querySelectorAll('th, td')].filter((cell) => cell.classList.contains('chat-cell--prose'));
  assert.equal(prose.length, 3);
});
