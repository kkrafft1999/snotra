/**
 * Full-text search over the bundled manual (#847).
 *
 * About forty pages per language, so an index in memory is enough: no
 * Pagefind, no worker, no network. Every page is split at its headings into
 * sections, each with the anchor the help window gives that heading — a hit
 * opens the page right at the section it was found in.
 *
 * Matching ignores case and accents (`Schlussel` finds *Schlüssel*, `ss` finds
 * *ß*). Every word of the query has to occur on the page; a word in the title
 * counts most, then in a heading, the description, the text. A whole word
 * counts more than the start of one (`mode` in *model*), and that more than a
 * hit inside a word — which only counts from four letters on, so that `modus`
 * still finds *Standardmodus* but `ai` does not find every *email*.
 */

/** Below this the list would be the whole manual. */
export const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 30;
const EXCERPT_BEFORE = 48;
const EXCERPT_AFTER = 120;

const WEIGHT = Object.freeze({ title: 12, heading: 6, description: 4, text: 1 });
/** How well a hit fits: a whole word, the start of a word, inside a word. */
const FIT = Object.freeze({ word: 1, start: 0.6, inside: 0.3 });
const MIN_INSIDE_LENGTH = 4;

/** `[since 1.17]` is a badge on the page, not words to find. */
const SINCE_MARKER = /\[(?:since|seit) \d+\.\d+(?:\.\d+)?\]\s*/gi;

/**
 * Lower case without accents, `ß` as `ss`, with a map from every folded
 * character back to the original one — so that a match found in the folded
 * text can be marked in the text the reader sees.
 */
export function fold(value) {
  const source = String(value ?? '');
  let text = '';
  const map = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const folded = char === 'ß' || char === 'ẞ'
      ? 'ss'
      : char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < folded.length; k += 1) {
      text += folded[k];
      map.push(i);
    }
  }
  return { text, map };
}

/** The words of a query, folded; empty when the query is too short to search. */
export function queryTerms(query) {
  const trimmed = String(query ?? '').trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];
  return [...new Set(fold(trimmed).text.split(/\s+/).filter(Boolean))];
}

// ── Index ───────────────────────────────────────────────────────────────────

/** The readable text of inline tokens — what the rendered heading shows. */
function inlineText(tokens) {
  let out = '';
  for (const token of tokens ?? []) {
    if (token.type === 'image') continue;
    if (token.tokens) out += inlineText(token.tokens);
    else if (token.type === 'br') out += ' ';
    else out += token.text ?? '';
  }
  return out;
}

/** The readable text of a block token, lists and tables included. */
function blockText(token) {
  if (token.type === 'space' || token.type === 'hr') return '';
  if (token.type === 'code') return token.text ?? '';
  if (token.type === 'table') {
    const cells = [...token.header, ...token.rows.flat()];
    return cells.map((cell) => inlineText(cell.tokens)).join(' · ');
  }
  if (token.type === 'list') return token.items.map((item) => blocksText(item.tokens)).join(' ');
  if (token.tokens) return inlineText(token.tokens);
  return token.text ?? '';
}

function blocksText(tokens) {
  return tokens.map(blockText).filter(Boolean).join(' ');
}

function clean(text) {
  return text.replace(SINCE_MARKER, '').replace(/\s+/g, ' ').trim();
}

/**
 * Builds the index from `{ slug, title, description, chapter, markdown }` per
 * page. `lexer` is marked's, `slugify` the heading slug of the help window
 * (`headingSlug`), counted up for repeats the same way it does.
 */
export function buildSearchIndex(pages, { lexer, slugify }) {
  return pages.map((page) => {
    const sections = [];
    let current = { heading: '', anchor: null, parts: [] };
    const seen = new Map();
    for (const token of lexer(page.markdown ?? '')) {
      if (token.type === 'heading') {
        sections.push(current);
        const heading = clean(inlineText(token.tokens));
        const base = slugify(heading);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        current = { heading, anchor: count === 0 ? base : `${base}-${count}`, parts: [] };
      } else {
        current.parts.push(blockText(token));
      }
    }
    sections.push(current);

    return {
      slug: page.slug,
      title: page.title ?? '',
      chapter: page.chapter ?? null,
      folded: {
        title: fold(page.title).text,
        description: fold(page.description).text,
      },
      sections: sections
        .map(({ heading, anchor, parts }) => {
          const text = clean(parts.filter(Boolean).join(' '));
          return { heading, anchor, text, folded: { heading: fold(heading).text, text: fold(text) } };
        })
        .filter((section) => section.heading || section.text),
    };
  });
}

// ── Search ──────────────────────────────────────────────────────────────────

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** How a hit at `at` sits in the text — 0 when it does not count. */
function fitAt(haystack, at, term) {
  const startsWord = at === 0 || !WORD_CHAR.test(haystack[at - 1]);
  const endsWord = at + term.length >= haystack.length || !WORD_CHAR.test(haystack[at + term.length]);
  if (startsWord) return endsWord ? FIT.word : FIT.start;
  return term.length >= MIN_INSIDE_LENGTH ? FIT.inside : 0;
}

/** The best fit of `term` anywhere in `haystack`, 0 for none. */
function bestFit(haystack, term) {
  let best = 0;
  for (let at = haystack.indexOf(term); at !== -1 && best < FIT.word; at = haystack.indexOf(term, at + 1)) {
    best = Math.max(best, fitAt(haystack, at, term));
  }
  return best;
}

function sectionScore(section, terms) {
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const inHeading = bestFit(section.folded.heading, term);
    const inText = bestFit(section.folded.text.text, term);
    if (inHeading || inText) matched += 1;
    score += inHeading * WEIGHT.heading + inText * WEIGHT.text;
  }
  return { score, matched };
}

/** Parts of the excerpt: `{ text, match }`, the matches to be marked. */
function excerptOf(section, terms) {
  const { text } = section;
  const folded = section.folded.text;
  if (!text) return [];
  // Every hit that counts, as ranges in the folded text.
  const hits = [];
  for (const term of terms) {
    for (let at = folded.text.indexOf(term); at !== -1; at = folded.text.indexOf(term, at + term.length)) {
      if (fitAt(folded.text, at, term) > 0) hits.push([at, at + term.length]);
    }
  }
  const first = hits.length ? Math.min(...hits.map(([at]) => at)) : -1;
  const centre = first === -1 ? 0 : folded.map[first];
  let start = Math.max(0, centre - EXCERPT_BEFORE);
  let end = Math.min(text.length, centre + EXCERPT_AFTER);
  // Whole words at both ends.
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < centre) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > centre) end = space;
  }

  // The matches, as ranges in the original text, inside the window.
  const ranges = [];
  for (const [from, to] of hits) {
    const range = [folded.map[from], folded.map[to - 1] + 1];
    if (range[0] >= start && range[1] <= end) ranges.push(range);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }

  const parts = [];
  if (start > 0) parts.push({ text: '… ', match: false });
  let cursor = start;
  for (const [from, to] of merged) {
    if (from > cursor) parts.push({ text: text.slice(cursor, from), match: false });
    parts.push({ text: text.slice(from, to), match: true });
    cursor = to;
  }
  if (cursor < end) parts.push({ text: text.slice(cursor, end), match: false });
  if (end < text.length) parts.push({ text: ' …', match: false });
  return parts;
}

/**
 * The pages that hold every word of `query`, best first, one entry per page:
 * `{ slug, title, chapter, heading, anchor, excerpt }`. `heading` and `anchor`
 * name the section the words were found in, or are null for the page's intro.
 */
export function searchManual(index, query, { limit = MAX_RESULTS } = {}) {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const results = [];
  for (const page of index) {
    let score = 0;
    let complete = true;
    for (const term of terms) {
      const inTitle = bestFit(page.folded.title, term);
      const inDescription = bestFit(page.folded.description, term);
      const inSections = page.sections.some((s) => bestFit(s.folded.heading, term) || bestFit(s.folded.text.text, term));
      if (!inTitle && !inDescription && !inSections) {
        complete = false;
        break;
      }
      score += inTitle * WEIGHT.title + inDescription * WEIGHT.description;
    }
    if (!complete) continue;

    let best = null;
    for (const section of page.sections) {
      const ranked = sectionScore(section, terms);
      if (ranked.matched === 0) continue;
      if (!best || ranked.matched > best.matched || (ranked.matched === best.matched && ranked.score > best.score)) {
        best = { section, ...ranked };
      }
    }
    if (best) score += best.score;
    const section = best?.section ?? page.sections[0] ?? null;
    results.push({
      slug: page.slug,
      title: page.title,
      chapter: page.chapter,
      heading: best?.section.heading || null,
      anchor: best?.section.anchor ?? null,
      excerpt: section ? excerptOf(section, terms) : [],
      score,
    });
  }
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results.slice(0, limit);
}
