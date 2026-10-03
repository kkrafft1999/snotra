// From main's runs to the rows of the diff view (#348) — DOM-free, so the
// folding can be tested without a node.
//
// Main sends the lines of both sides and runs of `equal | delete | insert`.
// What the view shows: every changed line, three unchanged lines around each
// change, and the rest folded into gaps the user can open.

/** Unchanged lines shown before and after each change. */
export const CONTEXT_LINES = 3;

/**
 * Rows in order. A line is `{ kind: 'line', type, oldNo, newNo, text }` with
 * 1-based numbers (null on the side the line does not exist); a gap is
 * `{ kind: 'gap', lines: [line…] }` and stands for unchanged lines folded away.
 * A gap of a single line is not worth a button: that line is shown instead.
 */
export function buildDiffRows({ segments, beforeLines, afterLines }, { context = CONTEXT_LINES } = {}) {
  const runs = Array.isArray(segments) ? segments : [];
  const before = Array.isArray(beforeLines) ? beforeLines : [];
  const after = Array.isArray(afterLines) ? afterLines : [];
  const rows = [];
  let oldIndex = 0;
  let newIndex = 0;

  const equalLine = () => {
    const line = { kind: 'line', type: 'equal', oldNo: oldIndex + 1, newNo: newIndex + 1, text: after[newIndex] ?? '' };
    oldIndex += 1;
    newIndex += 1;
    return line;
  };

  runs.forEach((run, position) => {
    const count = Number.isSafeInteger(run?.count) && run.count > 0 ? run.count : 0;
    if (run?.op === 'delete') {
      for (let i = 0; i < count; i += 1) {
        rows.push({ kind: 'line', type: 'delete', oldNo: oldIndex + 1, newNo: null, text: before[oldIndex] ?? '' });
        oldIndex += 1;
      }
      return;
    }
    if (run?.op === 'insert') {
      for (let i = 0; i < count; i += 1) {
        rows.push({ kind: 'line', type: 'insert', oldNo: null, newNo: newIndex + 1, text: after[newIndex] ?? '' });
        newIndex += 1;
      }
      return;
    }
    const lines = [];
    for (let i = 0; i < count; i += 1) lines.push(equalLine());
    const first = position === 0;
    const last = position === runs.length - 1;
    const keepHead = first ? 0 : context;
    const keepTail = last ? 0 : context;
    if (lines.length - keepHead - keepTail <= 1) {
      rows.push(...lines);
      return;
    }
    rows.push(...lines.slice(0, keepHead));
    rows.push({ kind: 'gap', lines: lines.slice(keepHead, lines.length - keepTail) });
    rows.push(...lines.slice(lines.length - keepTail));
  });
  return rows;
}
