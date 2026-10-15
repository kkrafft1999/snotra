/**
 * Tables in a chat answer (#961).
 *
 * The styling lives in `styles.css`; what CSS cannot know is decided here, on
 * the sanitized tree before it goes on screen:
 *
 * - Every table sits in a frame that scrolls sideways, so a wide one stays
 *   inside the answer column instead of running out of it.
 * - A column whose cells are all numbers is aligned right, so that the digits
 *   line up. Markdown that sets an alignment itself (`|---:|`) is left alone.
 * - A short value — a number, a date, "yes" — keeps its line, and a column of
 *   sentences keeps a readable width. In a narrow chat the table scrolls
 *   rather than standing one word per line.
 */

// A number as people write it in a table: thousands grouped by a space, dot,
// comma or apostrophe, an optional sign, currency and unit. A date
// (14.10.2026) or a version (1.22.0) does not match and stays left.
const NUMBER = new RegExp(
  '^[+\\-−±]?[€$£]?\\s?' +
  '(?:\\d{1,3}(?:[   .,\']\\d{3})+|\\d+)(?:[.,]\\d+)?' +
  '\\s?(?:%|‰|[a-zA-Zµ€$£]{1,3})?$',
);

// Up to this many characters a cell is a value and does not wrap; a column
// with a cell longer than PROSE_CELL is prose and keeps a minimum width.
const SHORT_CELL = 12;
const PROSE_CELL = 40;

// What an empty cell looks like in a model's table. It neither makes a column
// numeric nor stops it from being one.
const BLANK = /^(?:|[-–—]|n\/a)$/i;

export function isNumericCell(text) {
  return NUMBER.test(text.trim());
}

function hasOwnAlignment(cell) {
  return cell.hasAttribute('align') || /text-align/i.test(cell.getAttribute('style') || '');
}

function markColumns(table) {
  const head = [...(table.querySelector(':scope > thead > tr')?.children ?? [])];
  const rows = [...table.querySelectorAll(':scope > tbody > tr')].map((row) => [...row.children]);
  head.forEach((headCell, col) => {
    const cells = rows.map((row) => row[col]).filter(Boolean);
    const texts = cells.map((cell) => cell.textContent.trim());
    cells.forEach((cell, i) => {
      if ([...texts[i]].length <= SHORT_CELL) cell.classList.add('chat-cell--short');
    });
    if (texts.some((text) => [...text].length > PROSE_CELL)) {
      for (const cell of [headCell, ...cells]) cell.classList.add('chat-cell--prose');
    }
    if (hasOwnAlignment(headCell)) return;
    const values = texts.filter((text) => !BLANK.test(text));
    if (values.length === 0 || !values.every(isNumericCell)) return;
    for (const cell of [headCell, ...cells]) cell.classList.add('chat-cell--num');
  });
}

/** Frames every table under `root` and marks its columns for the stylesheet. */
export function prepareChatTables(root) {
  for (const table of root.querySelectorAll('table')) {
    markColumns(table);
    const frame = table.ownerDocument.createElement('div');
    frame.className = 'chat-table-frame';
    table.replaceWith(frame);
    frame.append(table);
  }
  return root;
}
