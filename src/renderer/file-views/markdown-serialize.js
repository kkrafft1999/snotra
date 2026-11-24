// Markdown from an edited block of the preview (#1422).
//
// The preview is edited where it is read; what the reader changed has to go
// back into the file as Markdown. This module turns one top-level block of
// the preview — a paragraph, a heading, a list, a quote — into the Markdown
// that renders it again. Only blocks the reader changed ever pass through
// here (see `markdown-splice.js`): an untouched block keeps its source byte
// for byte, so the choices made here — `**` for bold, `*` for italics, `-`
// for a bullet unless the list used another — only show where the reader
// actually typed.
//
// What it can write is deliberately small: the formats the toolbar offers,
// links, line breaks and comments (#1388). A block that holds anything else —
// an image, inline HTML, a footnote — is not editable in the preview at all
// (`isEditableBlock`); it stays as it is, and the source is where it is
// changed. That is the line between "the preview may rewrite this" and "it
// would lose something".

const ELEMENT = 1;
const TEXT = 3;

/** Inline formats, outermost first: the order delimiters open in. */
const MARKS = Object.freeze({
  comment: { order: 0 },
  link: { order: 1 },
  strong: { order: 2, delimiter: '**' },
  em: { order: 3, delimiter: '*' },
  del: { order: 4, delimiter: '~~' },
});

const MARK_OF_TAG = Object.freeze({
  STRONG: 'strong',
  B: 'strong',
  EM: 'em',
  I: 'em',
  DEL: 'del',
  S: 'del',
  STRIKE: 'del',
});

const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const LISTS = new Set(['UL', 'OL']);
/** Elements the editor may leave inside a block that carry no meaning of their own. */
const TRANSPARENT = new Set(['SPAN', 'FONT', 'U', 'SMALL', 'BIG']);
/** Inside a block: elements the preview can write back. */
const INLINE_OK = new Set(['STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'STRIKE', 'CODE', 'A', 'BR', 'MARK']);

// The comment marker's word joiner (#1388) and the editor's seam (#1422): never text.
const INVISIBLE = /[\u2060\u200b]/g;
const isUiDecoration = (el) => el.classList?.contains('md-comment-marker');

// ── What can be edited ──────────────────────────────────────────────────────

function inlineEditable(node) {
  for (const child of node.childNodes) {
    if (child.nodeType !== ELEMENT) continue;
    if (isUiDecoration(child)) continue;
    if (!INLINE_OK.has(child.tagName)) return false;
    if (child.tagName === 'MARK' && !child.classList.contains('md-comment')) return false;
    if (!inlineEditable(child)) return false;
  }
  return true;
}

function listEditable(list) {
  for (const item of list.children) {
    if (item.tagName !== 'LI') return false;
    for (const child of item.childNodes) {
      if (child.nodeType !== ELEMENT || isUiDecoration(child)) continue;
      if (child.tagName === 'INPUT') {
        if (child.type !== 'checkbox') return false;
      } else if (LISTS.has(child.tagName)) {
        if (!listEditable(child)) return false;
      } else if (child.tagName === 'P') {
        if (!inlineEditable(child)) return false;
      } else if (!INLINE_OK.has(child.tagName) || !inlineEditable(child)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Can the reader edit this top-level block of the preview, and can it be
 * written back without losing anything?
 */
export function isEditableBlock(el) {
  if (!el || el.nodeType !== ELEMENT) return false;
  if (el.tagName === 'P') {
    if (el.classList.contains('md-figure') || el.classList.contains('md-empty')) return false;
    return inlineEditable(el);
  }
  if (HEADINGS.has(el.tagName)) return inlineEditable(el);
  if (LISTS.has(el.tagName)) return listEditable(el);
  if (el.tagName === 'BLOCKQUOTE') {
    return [...el.children].every((child) => {
      if (child.tagName === 'P' || HEADINGS.has(child.tagName)) return inlineEditable(child);
      if (LISTS.has(child.tagName)) return listEditable(child);
      return child.tagName === 'BLOCKQUOTE' && isEditableBlock(child);
    });
  }
  return false;
}

// ── Inline ──────────────────────────────────────────────────────────────────

/**
 * The inline content of a node, flattened into runs: `{ text, marks }`,
 * `{ code, marks }`, `{ atom, marks }` (Markdown written as it is) and
 * `{ br: true, marks }`. A mark is `{ type, attrs }`.
 */
function collectRuns(node, marks, runs) {
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT) {
      const text = child.data.replace(INVISIBLE, '').replace(/\u00a0/g, ' ');
      if (text) runs.push({ text, marks });
      continue;
    }
    if (child.nodeType !== ELEMENT || isUiDecoration(child)) continue;
    const tag = child.tagName;
    if (tag === 'BR') {
      runs.push({ br: true, marks });
    } else if (tag === 'CODE') {
      const code = child.textContent.replace(INVISIBLE, '').replace(/\u00a0/g, ' ');
      if (code) runs.push({ code, marks });
    } else if (MARK_OF_TAG[tag]) {
      collectRuns(child, withMark(marks, { type: MARK_OF_TAG[tag] }), runs);
    } else if (tag === 'A') {
      const href = child.getAttribute('data-md-href') ?? child.getAttribute('href') ?? '';
      if (!href || href === '#') {
        collectRuns(child, marks, runs);
      } else {
        // The view rewrites `title` for its tooltip; it keeps the written one aside.
        const title = child.getAttribute('data-md-title')
          ?? (child.hasAttribute('data-md-href') ? '' : child.getAttribute('title') ?? '');
        collectRuns(child, withMark(marks, { type: 'link', attrs: { href, title, node: child } }), runs);
      }
    } else if (tag === 'MARK' && child.classList.contains('md-comment')) {
      const raw = child.getAttribute('data-md-raw');
      if (child.classList.contains('md-comment--point')) {
        if (raw) runs.push({ atom: raw, marks });
      } else {
        // The comment and its replies, as they were written after the passage.
        const tail = raw ? raw.replace(/^\{==[\s\S]+?==\}/, '') : '';
        collectRuns(child, withMark(marks, { type: 'comment', attrs: { tail, node: child } }), runs);
      }
    } else if (tag === 'INPUT') {
      // A task's box is written by the list, not as text.
    } else {
      // `<span>`, `<font>` and the like the editing engine leaves behind: their
      // text counts, their wrapper does not.
      collectRuns(child, marks, runs);
    }
  }
  return runs;
}

function withMark(marks, mark) {
  // `<b>` inside `<strong>` is still bold once.
  if (mark.type !== 'link' && mark.type !== 'comment' && marks.some((m) => m.type === mark.type)) return marks;
  return [...marks, mark].sort((a, b) => MARKS[a.type].order - MARKS[b.type].order);
}

const sameMark = (a, b) => a.type === b.type && (a.attrs?.node ?? null) === (b.attrs?.node ?? null);

/** Backslash escapes for text that must stay text. */
function escapeText(text) {
  return text
    .replace(/[\\`*[\]~]/g, '\\$&')
    // `_` only where it could open or close emphasis: snake_case stays as it is.
    .replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (match) => match.replace('_', '\\_'))
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
    // A comment of its own, typed by the reader, would become one (#1388).
    .replace(/\{(?===|>>)/g, '\\{');
}

function codeSpan(code) {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(code) || (/^ /.test(code) && / $/.test(code) && code.trim()) ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

function linkDestination(href) {
  if (/[\s()<>]/.test(href)) return `<${href.replace(/[<>]/g, (c) => encodeURIComponent(c))}>`;
  return href;
}

function openDelimiter(mark) {
  if (mark.type === 'comment') return '{==';
  if (mark.type === 'link') return '[';
  return MARKS[mark.type].delimiter;
}

function closeDelimiter(mark) {
  if (mark.type === 'comment') return `==}${mark.attrs.tail}`;
  if (mark.type === 'link') {
    const { href, title } = mark.attrs;
    const titlePart = title ? ` "${title.replace(/["\\]/g, '\\$&')}"` : '';
    return `](${linkDestination(href)}${titlePart})`;
  }
  return MARKS[mark.type].delimiter;
}

/**
 * A link whose text is its address, and nothing else inside: written as an
 * autolink, `<https://…>`, so that a URL does not come back as `[url](url)`.
 */
function autolinkOf(runs, mark) {
  const inside = runs.filter((run) => run.marks.some((m) => sameMark(m, mark)));
  if (inside.length !== 1 || inside[0].text === undefined || inside[0].marks.length !== 1) return null;
  const { href } = mark.attrs;
  const text = inside[0].text;
  if (text === href && /^https?:\/\/\S+$/.test(href)) return `<${href}>`;
  if (`mailto:${text}` === href && /^\S+@\S+$/.test(text)) return `<${text}>`;
  return null;
}

/**
 * Writes runs as Markdown. Whitespace at the edge of a format goes outside
 * its delimiters — `**word **` is not bold in Markdown, `**word** ` is.
 */
function writeRuns(runs) {
  // Split whitespace off the ends of text runs, so that it can stand outside.
  const pieces = [];
  for (const run of runs) {
    if (run.text === undefined) {
      pieces.push(run);
      continue;
    }
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text);
    if (lead) pieces.push({ text: lead, marks: run.marks, space: true });
    if (core) pieces.push({ text: core, marks: run.marks });
    if (trail) pieces.push({ text: trail, marks: run.marks, space: true });
  }
  // Whitespace takes only the formats shared with both neighbours.
  pieces.forEach((piece, i) => {
    if (!piece.space) return;
    const neighbour = (step) => {
      for (let j = i + step; j >= 0 && j < pieces.length; j += step) if (!pieces[j].space) return pieces[j].marks;
      return [];
    };
    const before = neighbour(-1);
    const after = neighbour(1);
    piece.marks = piece.marks.filter((m) => before.some((b) => sameMark(b, m)) && after.some((a) => sameMark(a, m)));
  });

  let out = '';
  const open = [];
  const autolinks = new Map();
  for (const piece of pieces) {
    // Close down to what this piece shares with the open ones, then open the rest.
    let keep = 0;
    while (keep < open.length && keep < piece.marks.length && sameMark(open[keep], piece.marks[keep])) keep += 1;
    while (open.length > keep) {
      const mark = open.pop();
      out += autolinks.has(mark) ? '' : closeDelimiter(mark);
    }
    for (const mark of piece.marks.slice(keep)) {
      open.push(mark);
      const auto = mark.type === 'link' ? autolinkOf(runs, mark) : null;
      if (auto) {
        autolinks.set(mark, auto);
        out += auto;
      } else {
        out += openDelimiter(mark);
      }
    }
    const insideAutolink = open.some((mark) => autolinks.has(mark));
    if (insideAutolink) continue;
    if (piece.space) {
      // HTML shows a run of blanks as one; so does Markdown — the file need
      // not keep the rest.
      out += /[ \n]$/.test(out) ? piece.text.replace(/^ +/, '') : piece.text;
    } else if (piece.br) out += '\\\n';
    else if (piece.code !== undefined) out += codeSpan(piece.code);
    else if (piece.atom !== undefined) out += piece.atom;
    else out += escapeText(piece.text);
  }
  while (open.length) {
    const mark = open.pop();
    out += autolinks.has(mark) ? '' : closeDelimiter(mark);
  }
  return out;
}

/**
 * What would read as a block of its own at the start of a line — a heading,
 * a list, a quote, a rule, a numbered item — is escaped there.
 */
function escapeLineStarts(text) {
  return text
    .split('\n')
    .map((line) => line
      .replace(/^[ \t]+|[ \t]+$/g, '')
      .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
      .replace(/^>/, '\\>')
      .replace(/^([-+])(?=\s|$)/, '\\$1')
      .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
      .replace(/^(=+|-+)$/, '\\$1'))
    .join('\n');
}

const isFiller = (run) => run.br || (run.text !== undefined && !run.text.trim());

/**
 * The inline content of an element as Markdown, without block syntax. Line
 * breaks and blanks at either end carry nothing — the editing engine leaves a
 * `<br>` in an empty line — and are dropped. `lineStarts: false` for a
 * heading, where nothing after the `#` can start a block.
 */
export function serializeInline(node, { lineStarts = true } = {}) {
  const runs = collectRuns(node, [], []);
  while (runs.length && isFiller(runs[0])) runs.shift();
  while (runs.length && isFiller(runs.at(-1))) runs.pop();
  const text = writeRuns(runs);
  return lineStarts ? escapeLineStarts(text) : text;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

/** The marker a bullet list uses: as written, else a dash. */
function bulletOf(options) {
  return ['-', '*', '+'].includes(options.bullet) ? options.bullet : '-';
}

function indent(text, by) {
  const pad = ' '.repeat(by);
  return text.split('\n').map((line) => (line ? pad + line : line)).join('\n');
}

function serializeListItem(item, marker, options) {
  let task = '';
  const inline = document.createDocumentFragment();
  const blocks = [];
  let seenContent = false;
  for (const child of [...item.childNodes]) {
    if (child.nodeType === ELEMENT && child.tagName === 'INPUT' && child.type === 'checkbox' && !seenContent) {
      task = child.checked || child.hasAttribute('checked') ? '[x] ' : '[ ] ';
      continue;
    }
    if (child.nodeType === ELEMENT && (LISTS.has(child.tagName) || child.tagName === 'P' || child.tagName === 'DIV'
      || child.tagName === 'BLOCKQUOTE' || HEADINGS.has(child.tagName))) {
      blocks.push(child);
      seenContent = true;
      continue;
    }
    if (blocks.length) {
      // Text after a nested block (the editor can leave some) is a paragraph of its own.
      const wrapper = document.createElement('p');
      wrapper.append(child.cloneNode(true));
      blocks.push(wrapper);
      continue;
    }
    if (child.nodeType === TEXT && !child.data.trim() && !seenContent) continue;
    inline.append(child.cloneNode(true));
    seenContent = true;
  }

  const parts = [];
  const inlineText = serializeInline(inline);
  if (inlineText) parts.push(inlineText);
  for (const block of blocks) {
    const text = serializeBlock(block, options);
    if (text) parts.push(text);
  }
  const loose = [...item.children].some((child) => child.tagName === 'P');
  const first = parts.shift() ?? '';
  // Continuation lines and nested blocks line up with the item's text.
  const width = marker.length + 1;
  let out = `${marker} ${task}${indent(first, width).slice(width)}`.replace(/\s+$/, '');
  for (const part of parts) out += (loose ? '\n\n' : '\n') + indent(part, width);
  return { text: out, loose };
}

function serializeList(list, options) {
  const ordered = list.tagName === 'OL';
  const startAttr = Number.parseInt(list.getAttribute('start') ?? '1', 10);
  const start = Number.isFinite(startAttr) && startAttr >= 0 ? startAttr : 1;
  const delimiter = options.orderedDelimiter === ')' ? ')' : '.';
  const items = [...list.children].filter((child) => child.tagName === 'LI');
  // Nested lists keep the outer list's choices.
  const written = items.map((item, i) => serializeListItem(item, ordered ? `${start + i}${delimiter}` : bulletOf(options), options));
  const loose = written.some((item) => item.loose);
  return written.map((item) => item.text).join(loose ? '\n\n' : '\n');
}

/**
 * The Markdown of one top-level block of the preview, as the reader left it.
 * `options.bullet` and `options.orderedDelimiter` keep the list style the
 * block had; an empty string means the block holds nothing to write.
 */
export function serializeBlock(el, options = {}) {
  if (!el || el.nodeType !== ELEMENT) return '';
  const tag = el.tagName;
  if (HEADINGS.has(tag)) {
    const text = serializeInline(el, { lineStarts: false })
      .replace(/\\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      // A heading that ends in ` #` would lose it as its closing sequence.
      .replace(/(\s)(#+)$/, '$1\\$2');
    return text ? `${'#'.repeat(Number(tag[1]))} ${text}` : '';
  }
  if (LISTS.has(tag)) return serializeList(el, options);
  if (tag === 'BLOCKQUOTE') {
    const parts = [];
    let loose = document.createDocumentFragment();
    const flush = () => {
      const text = serializeInline(loose);
      if (text) parts.push(text);
      loose = document.createDocumentFragment();
    };
    for (const child of [...el.childNodes]) {
      if (child.nodeType === ELEMENT && (child.tagName === 'P' || child.tagName === 'DIV' || HEADINGS.has(child.tagName)
        || LISTS.has(child.tagName) || child.tagName === 'BLOCKQUOTE')) {
        flush();
        const text = serializeBlock(child, options);
        if (text) parts.push(text);
      } else {
        loose.append(child.cloneNode(true));
      }
    }
    flush();
    if (!parts.length) return '';
    return parts.join('\n\n').split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
  }
  if (tag === 'HR') return '---';
  // A paragraph — and whatever else the editing engine made of one: Chromium
  // turns a paragraph into a heading by putting the heading inside it.
  const blocks = (tag === 'DIV' || tag === 'P')
    ? [...el.children].filter((child) => HEADINGS.has(child.tagName) || LISTS.has(child.tagName)
      || child.tagName === 'P' || child.tagName === 'DIV' || child.tagName === 'BLOCKQUOTE')
    : [];
  if (blocks.length) {
    const parts = [];
    let loose = document.createDocumentFragment();
    const flush = () => {
      const text = serializeInline(loose);
      if (text) parts.push(text);
      loose = document.createDocumentFragment();
    };
    for (const child of [...el.childNodes]) {
      if (blocks.includes(child)) {
        flush();
        const text = serializeBlock(child, options);
        if (text) parts.push(text);
      } else {
        loose.append(child.cloneNode(true));
      }
    }
    flush();
    return parts.join('\n\n');
  }
  return serializeInline(el);
}
