// Writing an edited preview back into its file (#1422): only what changed.
//
// The preview knows, for every top-level block it shows, where that block
// came from in the source (`data-md-range`, #1388). When the reader edits
// the preview, each block on screen is one of three things:
//
//   * kept      — an original block, unchanged: its source stays byte for byte;
//   * replaced  — an original block the reader changed: its source is swapped
//                 for the block's new Markdown;
//   * new       — a block the reader made (Enter at the end of a paragraph,
//                 say): its Markdown goes in after the block before it.
//
// An original block that is no longer on screen was deleted. What lies
// between the blocks — blank lines, link definitions, HTML comments, anything
// that renders nothing — stays. So a changed word changes one block in the
// file, and `git diff` shows exactly that.
//
// DOM-free, so that the rules below are tested on strings alone.

const isBlank = (gap) => !/\S/.test(gap);
const breaksIn = (gap) => (gap.match(/\n/g) ?? []).length;

/**
 * The line ending the file uses: `\r\n` when it has any, so that a block
 * written into a Windows file does not leave it with mixed endings.
 */
export function lineEndingOf(text) {
  return String(text ?? '').includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Where a block's content ends. A code block's range carries the newline
 * after its closing fence; that newline belongs to the gap after it, as it
 * does for every other block.
 */
function contentEnd(text, { start, end }) {
  let at = end;
  while (at > start && /\s/.test(text[at - 1])) at -= 1;
  return at;
}

/**
 * Builds the new body.
 *
 *   body    the Markdown as it is on disk (the part after the front matter)
 *   blocks  the original blocks, `{ start, end }` in `body`, in order
 *   items   the blocks on screen, in order, as `{ orig, text }`: `orig` is
 *           the index into `blocks`, or null for a new block; `text` is the
 *           block's Markdown, or null for an original block that is
 *           unchanged. A `text` that is empty once trimmed writes nothing —
 *           an empty paragraph has no Markdown.
 *
 * The `orig` of the items rise; the view sees to that.
 *
 * Returns `{ text, ranges }`: the new body, and for every item where its
 * Markdown now stands (null for an item that wrote nothing) — the ranges the
 * next save starts from.
 */
export function spliceBlocks(body, blocks, items) {
  const source = String(body ?? '');
  const eol = lineEndingOf(source);
  const separator = eol + eol;
  const spans = blocks.map((block) => ({ start: block.start, end: contentEnd(source, block) }));
  // gaps[k] lies before block k; gaps[n] after the last one. A body without
  // blocks is all gap: blank, it is the end of the file; otherwise its start.
  const gaps = spans.map((span, k) => source.slice(k === 0 ? 0 : spans[k - 1].end, span.start));
  if (spans.length) gaps.push(source.slice(spans.at(-1).end));
  else gaps.push(...(isBlank(source) ? ['', source] : [source, '']));

  const entries = [];
  let lastOrig = -1;
  items.forEach((item, index) => {
    const isNew = item.orig === null || item.orig === undefined;
    if (!isNew && (item.orig <= lastOrig || item.orig >= spans.length)) {
      throw new Error(`block ${item.orig} is out of order`);
    }
    if (!isNew) lastOrig = item.orig;
    let text;
    if (item.text === null || item.text === undefined) {
      if (isNew) return;
      text = source.slice(spans[item.orig].start, spans[item.orig].end);
    } else {
      text = String(item.text).trim().replace(/\r\n|\r|\n/g, eol);
    }
    if (!text) return;
    entries.push({ index, orig: isNew ? null : item.orig, changed: item.text !== null && item.text !== undefined, text });
  });

  const ranges = items.map(() => null);
  let out = gaps[0];
  // The next gap that has not been written; gaps[0] is the start of the body.
  let nextGap = 1;
  let previous = null;

  for (const entry of entries) {
    if (entry.orig === null) {
      if (previous) out += separator;
      // Something that renders nothing at the very top stays apart from it.
      else if (!isBlank(out)) out = out.replace(/(?:\r?\n)*$/, separator);
    } else {
      const span = gaps.slice(nextGap, entry.orig + 1);
      nextGap = entry.orig + 1;
      // Whatever renders nothing but is not blank — a link definition, an
      // HTML comment — stays, even when the blocks around it went.
      const kept = span.filter((gap) => !isBlank(gap));
      if (kept.length) {
        out += kept.join('');
      } else if (previous) {
        const gap = span.at(-1) ?? '';
        const untouched = previous.orig === entry.orig - 1 && !previous.changed && !entry.changed;
        // Two blocks that were not touched keep what stood between them; a
        // changed block may have become another kind of block, and two blocks
        // with only a line break between them can run into one.
        out += untouched || breaksIn(gap) >= 2 ? gap : separator;
      }
    }
    ranges[entry.index] = { start: out.length, end: out.length + entry.text.length };
    out += entry.text;
    previous = entry;
  }

  // The end of the body: what renders nothing among the gaps that were not
  // written, and the file's last line ending.
  const rest = gaps.slice(nextGap);
  const tail = rest.at(-1) ?? '';
  out += rest.slice(0, -1).filter((gap) => !isBlank(gap)).join('').replace(/\s+$/, '') + tail;
  return { text: out, ranges };
}
