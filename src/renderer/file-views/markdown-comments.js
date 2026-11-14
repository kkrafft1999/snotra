// Comments in a Markdown file (#1388): the parts that need no mounted view.
//
// A comment is written into the file itself, as CriticMarkup:
//
//     {==the passage==}{>>Ada Lovelace, 2026-11-14: the comment<<}
//
// so that it travels with the file — git, a synced folder, an e-mail — and the
// agent reads it the moment it reads the file. Decided on 2026-11-14 in the
// issue, against a sidecar file and against app data.
//
// What happens here:
//   * a `marked` extension that renders `{==…==}{>>…<<}` as a highlight that
//     carries its comment, and a bare `{>>…<<}` as a point comment;
//   * the top-level blocks of a document with their place in the source, so
//     that a selection in the rendered preview can be traced back;
//   * finding the selected text inside its block's source, and checking the
//     result by rendering it — a comment is only written where it comes out
//     around exactly the text that was selected;
//   * the text of a comment: written, and read back.

/** How many pieces of syntax a range may grow by on each side to stay whole. */
const MAX_GROWTH = 4;

/**
 * What may stand in the source between two characters the reader sees:
 * emphasis and code delimiters, a backslash escape, inline HTML, the
 * address part of a link, the brackets of a link, and CriticMarkup that is
 * already there. The last one is allowed so that an overlap is found and
 * refused with a reason, instead of not being found at all.
 */
const GAP = String.raw`(?:\\(?!\w)|[*_~\x60]+|<[^>\n]*>|\]\([^)\n]*\)|\]\[[^\]\n]*\]|[\[\]!]|\{>>[\s\S]*?<<\}|\{==|==\})*`;

const COMMENT_META = /^(?:(.+?), )?(\d{4}-\d{2}-\d{2}): ([\s\S]*)$/;
const CRITIC_MARKERS = /\{==|==\}|\{>>|<<\}/;

/** Reasons a selection cannot be commented, as `error` of `locateSelection`. */
export const COMMENT_ERRORS = Object.freeze({
  EMPTY: 'empty',
  NOT_FOUND: 'not-found',
  AMBIGUOUS: 'ambiguous',
  OVERLAP: 'overlap',
});

function escapeAttribute(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegExp(char) {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whitespace as the reader sees it: one space for every run, none at the ends.
 * The word joiner the preview puts before a comment marker is not text.
 */
export function normalizeSpace(text) {
  return String(text ?? '').replace(/\u2060/g, '').replace(/\s+/g, ' ').trim();
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * The `marked` extension for CriticMarkup comments. `{==text==}` alone is a
 * highlight; followed by `{>>comment<<}` it carries that comment; a bare
 * `{>>comment<<}` is a comment on a point. Inline only: the inline lexer
 * never runs inside code, so `{==` in a code span stays text.
 */
export const criticMarkupExtension = Object.freeze({
  name: 'criticComment',
  level: 'inline',
  start(src) {
    const at = src.search(/\{==|\{>>/);
    return at === -1 ? undefined : at;
  },
  tokenizer(src) {
    const highlight = /^\{==([\s\S]+?)==\}(?:\{>>([\s\S]*?)<<\})?/.exec(src);
    if (highlight) {
      const token = { type: 'criticComment', raw: highlight[0], comment: highlight[2] ?? null, tokens: [] };
      this.lexer.inline(highlight[1], token.tokens);
      return token;
    }
    const point = /^\{>>([\s\S]*?)<<\}/.exec(src);
    if (point) return { type: 'criticComment', raw: point[0], comment: point[1], tokens: [] };
    return undefined;
  },
  renderer(token) {
    const inner = this.parser.parseInline(token.tokens);
    const point = token.tokens.length === 0;
    const comment = token.comment === null ? '' : ` data-md-comment="${escapeAttribute(token.comment)}"`;
    return `<mark class="md-comment${point ? ' md-comment--point' : ''}"${comment}>${inner}</mark>`;
  },
});

let previewParser = null;

/**
 * The `marked` the file preview renders with: the shared one, plus the
 * comments. A separate instance, so that the chat never renders CriticMarkup —
 * an answer that quotes `{==x==}` shows it as it is. Null without `marked`
 * (DOM tests that do not load it).
 */
export function previewMarked() {
  if (previewParser) return previewParser;
  const Marked = globalThis.marked?.Marked;
  if (typeof Marked !== 'function') return null;
  previewParser = new Marked({ extensions: [criticMarkupExtension] });
  return previewParser;
}

// ── Where the blocks are ────────────────────────────────────────────────────

/**
 * `marked` reads `\r\n` as `\n`. Offsets it hands out count the text without
 * the `\r`; this turns them back into offsets of the text as it is on disk.
 */
function originalOffsets(source) {
  const removed = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\r' && source[i + 1] === '\n') removed.push(i - removed.length);
  }
  return (offset) => {
    let shift = 0;
    while (shift < removed.length && removed[shift] < offset) shift += 1;
    return offset + shift;
  };
}

/**
 * The top-level blocks of a Markdown body that put something on screen, each
 * as `{ start, end }` in `body`, in order. Blank lines and link definitions
 * render nothing and are left out. Null when the tokens do not add up to the
 * text — then nothing can be traced back by block.
 */
export function sourceBlocks(body) {
  const parser = previewMarked();
  if (!parser) return null;
  const text = String(body ?? '');
  const normalized = text.replace(/\r\n|\r/g, '\n');
  let tokens;
  try {
    tokens = parser.lexer(normalized, { gfm: true, breaks: false });
  } catch {
    // marked rendered this text a moment ago; if it cannot lex it now, the
    // blocks stay untraced and a comment searches the whole body instead.
    return null;
  }
  const toOriginal = originalOffsets(text);
  const blocks = [];
  let at = 0;
  for (const token of tokens) {
    const end = at + token.raw.length;
    if (token.type !== 'space' && token.type !== 'def') {
      blocks.push({ start: toOriginal(at), end: toOriginal(end) });
    }
    at = end;
  }
  return at === normalized.length ? blocks : null;
}

/** Link definitions of a body, so that a block rendered alone still resolves `[x][ref]`. */
function linkDefinitions(body) {
  const parser = previewMarked();
  if (!parser) return '';
  try {
    return parser.lexer(String(body ?? '').replace(/\r\n|\r/g, '\n'))
      .filter((token) => token.type === 'def')
      .map((token) => token.raw.trim())
      .join('\n');
  } catch {
    // Without the definitions a reference link stays unresolved in the probe,
    // and a selection across it is refused — not written somewhere wrong.
    return '';
  }
}

// ── From a selection to the source ──────────────────────────────────────────

function patternFor(selected) {
  const parts = [];
  let spaced = false;
  for (const char of selected) {
    if (/\s/.test(char)) {
      spaced = true;
      continue;
    }
    if (parts.length > 0) parts.push(spaced ? `${GAP}\\s+${GAP}` : GAP);
    parts.push(escapeRegExp(char));
    spaced = false;
  }
  return new RegExp(parts.join(''), 'g');
}

/**
 * Where a text occurs, non-overlapping, as offsets. Used on the reader's side
 * (the block's text) and on the source side (its Markdown) alike.
 */
function occurrencesOf(text, needle) {
  const found = [];
  if (!needle) return found;
  let at = text.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = text.indexOf(needle, at + needle.length);
  }
  return found;
}

/**
 * Which occurrence of the selected text the reader picked, counted in the
 * text of its block: the one that starts closest to where the selection does.
 */
export function occurrenceIndex(blockText, selected, offsetBefore) {
  const positions = occurrencesOf(blockText, selected);
  if (positions.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < positions.length; i += 1) {
    if (Math.abs(positions[i] - offsetBefore) < Math.abs(positions[best] - offsetBefore)) best = i;
  }
  return best;
}

const PROBE = '\u0001probe\u0001';

/**
 * The text the highlight would come out around, once `[start, end)` of
 * `block` is wrapped — rendered for real, so that what is written is what
 * the reader will see marked. Null when no highlight comes out at all.
 */
function highlightedText(block, start, end, definitions) {
  const parser = previewMarked();
  if (!parser || typeof document === 'undefined') return null;
  const probe = `${block.slice(0, start)}{==${block.slice(start, end)}==}{>>${PROBE}<<}${block.slice(end)}`;
  let html;
  try {
    html = parser.parse(definitions ? `${probe}\n\n${definitions}\n` : probe, { gfm: true, breaks: false });
  } catch {
    // A probe that does not render is a range that does not hold: the next
    // candidate is tried, and with none left the selection is refused.
    return null;
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  const mark = [...template.content.querySelectorAll('mark.md-comment')]
    .find((el) => el.getAttribute('data-md-comment') === PROBE);
  return mark ? normalizeSpace(mark.textContent) : null;
}

/** What may be taken in on the left of a range: delimiters, an escape, the start of a link or image. */
const GROW_LEFT = /(?:[*_~\x60\\[]|!\[)$/;
/** On the right: delimiters, or the rest of a link — `](address)` or `][ref]`. */
const GROW_RIGHT = /^(?:[*_~\x60]|\]\([^)\n]*\)|\]\[[^\]\n]*\]|\])/;

/** The starts a range may grow to, nearest first. */
function leftEdges(block, start) {
  const edges = [start];
  let at = start;
  for (let step = 0; step < MAX_GROWTH; step += 1) {
    const grown = GROW_LEFT.exec(block.slice(0, at));
    if (!grown) break;
    at -= grown[0].length;
    edges.push(at);
  }
  return edges;
}

/** The ends a range may grow to, nearest first. */
function rightEdges(block, end) {
  const edges = [end];
  let at = end;
  for (let step = 0; step < MAX_GROWTH; step += 1) {
    const grown = GROW_RIGHT.exec(block.slice(at));
    if (!grown) break;
    at += grown[0].length;
    edges.push(at);
  }
  return edges;
}

/**
 * Grows `[start, end)` over the syntax right next to it — `**bold**`
 * selected as "bold" matches `bold`, and the text of a link stops before its
 * address; wrapping only that would cut the emphasis or the link in half —
 * until the rendered highlight covers exactly `selected`.
 */
function settleRange(block, start, end, selected, definitions) {
  const candidates = [];
  leftEdges(block, start).forEach((from, left) => {
    rightEdges(block, end).forEach((to, right) => candidates.push({ from, to, growth: left + right }));
  });
  candidates.sort((a, b) => a.growth - b.growth);
  for (const { from, to } of candidates) {
    if (highlightedText(block, from, to, definitions) === selected) return { start: from, end: to };
  }
  return null;
}

/**
 * Finds the selected text in the source of its block.
 *
 * `blockSource` is the Markdown of the block, `selected` the text the reader
 * selected (whitespace as it comes), `occurrence` which of the block's
 * occurrences of that text it was (`occurrenceIndex`), `body` the whole
 * Markdown for its link definitions.
 *
 * Answers `{ start, end }` in `blockSource`, or `{ error }` with one of
 * `COMMENT_ERRORS` — the view says why instead of writing a comment
 * somewhere else.
 */
export function locateSelection({ blockSource, selected, occurrence = 0, body = '' }) {
  const wanted = normalizeSpace(selected);
  if (!wanted) return { error: COMMENT_ERRORS.EMPTY };
  const block = String(blockSource ?? '');
  const pattern = patternFor(wanted);
  const matches = [];
  for (let match = pattern.exec(block); match; match = pattern.exec(block)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  if (matches.length === 0) return { error: COMMENT_ERRORS.NOT_FOUND };

  let match;
  if (matches.length === 1) match = matches[0];
  else if (occurrence >= 0 && occurrence < matches.length) match = matches[occurrence];
  else return { error: COMMENT_ERRORS.AMBIGUOUS };

  if (CRITIC_MARKERS.test(block.slice(match.start, match.end))) return { error: COMMENT_ERRORS.OVERLAP };
  const settled = settleRange(block, match.start, match.end, wanted, linkDefinitions(body));
  if (!settled) {
    return { error: matches.length > 1 ? COMMENT_ERRORS.AMBIGUOUS : COMMENT_ERRORS.NOT_FOUND };
  }
  return settled;
}

// ── The comment itself ──────────────────────────────────────────────────────

/** Today as `YYYY-MM-DD`, in local time — the date the reader sees on the clock. */
export function commentDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Keeps a piece of text from ending the comment early or breaking the line
 * it stands in: `<<}` would close it, a line break would end a table row or a
 * list item, a blank line the paragraph.
 */
function inlineText(text) {
  return String(text ?? '').replace(/\s*\n\s*/g, ' ').replace(/<<\}/g, '<< }').trim();
}

/** The author as it can stand in a comment, or '' — no line break, no `, date:` confusion. */
export function cleanAuthor(author) {
  return inlineText(author).replace(/:/g, '').slice(0, 80).trim();
}

/** What stands between `{>>` and `<<}`: `Author, 2026-11-14: text`, or `2026-11-14: text` without a name. */
export function formatComment({ author = '', date, text }) {
  const name = cleanAuthor(author);
  const body = inlineText(text);
  return name ? `${name}, ${date}: ${body}` : `${date}: ${body}`;
}

/** The parts of a comment written by `formatComment`; anything else is all text. */
export function parseComment(raw) {
  const text = String(raw ?? '').trim();
  const meta = COMMENT_META.exec(text);
  if (!meta) return { author: '', date: '', text };
  return { author: meta[1] ?? '', date: meta[2], text: meta[3].trim() };
}

/** `source` with `[start, end)` highlighted and the comment after it. */
export function insertComment(source, { start, end }, comment) {
  const text = String(source ?? '');
  return `${text.slice(0, start)}{==${text.slice(start, end)}==}{>>${formatComment(comment)}<<}${text.slice(end)}`;
}
