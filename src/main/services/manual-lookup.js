'use strict';

/**
 * The model's way into the bundled user manual (#947): `search_manual` and
 * `read_manual_page`.
 *
 * It ranks with the help window's own search and names the help window's own
 * anchors (both in `src/shared/` for that reason), so a hit the model reports
 * is the hit the user would get typing the same words. It reads through the
 * manual service and nothing else — a page by slug, never a path.
 *
 * What goes back is meant for a model, not for a screen: the excerpt as plain
 * text, a screenshot as its description, a link between pages as the address
 * on docs.snotra-ai.dev — the one the answer can hand on to the user.
 */

const vm = require('node:vm');
const {
  buildSearchIndex, pageSections, searchManual, MIN_QUERY_LENGTH, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS,
} = require('../../shared/manual/manual-search');
const { headingSlug } = require('../../shared/runtime/heading-slug');
const { manualWebUrl, normalizeManualLocale } = require('./manual-service');
const { parseManualAddress } = require('../../shared/manual/manual-address');
const { splitManualLocale } = require('../../shared/i18n/locales');

/** The longest page is about 15 000 characters; a section is far below. */
const MAX_PAGE_CHARS = 12_000;

/** `![alt](screenshots/x.webp)` — the picture means nothing here, its description does. */
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** An inline link whose target is relative: another page of the manual or an anchor. */
const LINK = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The slug the model means: `safety/sandbox`, as a search result names it, but
 * also `/safety/sandbox/`, `safety/sandbox.md` or the page's address on
 * docs.snotra-ai.dev — whatever it copied from an earlier answer. A fragment
 * becomes the anchor, the `de/` prefix the language, unless both were given.
 *
 * @param {unknown} reference
 * @returns {{ slug: string, anchor: string|null, locale: string|null }}
 */
function parsePageReference(reference) {
  let text = String(reference ?? '').trim();
  const address = parseManualAddress(text);
  if (address) return { slug: address.slug, anchor: address.fragment || null, locale: address.locale };
  /** @type {string | null} */
  let anchor = null;
  const hash = text.indexOf('#');
  if (hash !== -1) {
    anchor = text.slice(hash + 1) || null;
    text = text.slice(0, hash);
  }
  text = text.replace(/^\/+|\/+$/g, '');
  const { locale, rest } = splitManualLocale(text);
  text = rest;
  const slug = text.replace(/\.md$/, '').replace(/(?:^|\/)index$/, '') || 'index';
  try {
    anchor = anchor ? decodeURIComponent(anchor) : null;
  } catch {
    // A broken escape stays as it was; it then simply names no section.
  }
  return { slug, anchor, locale };
}

/**
 * Links of a page as addresses on the web manual, screenshots as their description.
 *
 * @param {string} markdown
 * @param {string} locale
 * @param {string} slug
 */
function forTheModel(markdown, locale, slug) {
  const pageUrl = manualWebUrl(locale, slug);
  return markdown
    .replace(IMAGE, (/** @type {string} */ _match, /** @type {string} */ alt) => (alt.trim() ? `*(Screenshot: ${alt.trim()})*` : ''))
    .replace(LINK, (/** @type {string} */ match, /** @type {string} */ label, /** @type {string} */ target, /** @type {string} */ title = '') => {
      if (ABSOLUTE.test(target)) return match;
      try {
        return `[${label}](${new URL(target, pageUrl).href}${title})`;
      } catch {
        return match;
      }
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * marked's lexer out of the copy the help window runs (`src/renderer/vendor`),
 * so both split a page the same way. `marked` itself is a dev dependency and
 * not in the packaged app; the UMD file sets a global when there is no
 * CommonJS around, so it runs in a context of its own — the same as in a page.
 *
 * @param {string} file
 * @param {{ readFileSync: (file: string, encoding: 'utf8') => string }} fs
 * @returns {import('../../shared/manual/manual-search').MarkdownLexer}
 */
function loadVendoredMarkedLexer(file, { readFileSync }) {
  /** @type {{ marked?: { lexer?: import('../../shared/manual/manual-search').MarkdownLexer } }} */
  const context = {};
  vm.runInNewContext(readFileSync(file, 'utf8'), context, { filename: file });
  const lexer = context.marked?.lexer;
  if (typeof lexer !== 'function') throw new Error('The vendored marked has no lexer.');
  return lexer;
}

/**
 * `manual` is the manual service, `loadLexer` returns marked's lexer — asked
 * for on the first call, so a chat that never looks anything up never loads it.
 *
 * @param {object} deps
 * @param {Pick<ReturnType<typeof import('./manual-service').createManualService>, 'isAvailable' | 'getAllPages' | 'getIndex' | 'getPage'>} deps.manual
 * @param {() => import('../../shared/manual/manual-search').MarkdownLexer} deps.loadLexer
 */
function createManualLookup({ manual, loadLexer }) {
  /** @type {Map<string, ReturnType<typeof buildSearchIndex>>} */
  const indexes = new Map();
  /** @type {import('../../shared/manual/manual-search').MarkdownLexer|null} */
  let lexer = null;

  function lex() {
    lexer ??= loadLexer();
    return lexer;
  }

  function isAvailable() {
    return Boolean(manual?.isAvailable?.());
  }

  /**
   * Built on the first search in a language and kept: the bundle never changes at runtime.
   *
   * @param {string} locale
   */
  function indexFor(locale) {
    let index = indexes.get(locale);
    if (!index) {
      index = buildSearchIndex(manual.getAllPages(locale), { lexer: lex(), slugify: headingSlug });
      indexes.set(locale, index);
    }
    return index;
  }

  /** @param {{ query?: unknown, locale?: unknown, limit?: unknown }} [request] */
  function search({ query, locale, limit } = {}) {
    const language = normalizeManualLocale(locale);
    const text = typeof query === 'string' ? query.trim() : '';
    if (text.length < MIN_QUERY_LENGTH) {
      return { error: `The query needs at least ${MIN_QUERY_LENGTH} characters.` };
    }
    const count = typeof limit === 'number' && Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_SEARCH_RESULTS) : DEFAULT_SEARCH_RESULTS;
    const results = searchManual(indexFor(language), text, { limit: count }).map((hit) => ({
      slug: hit.slug,
      title: hit.title,
      section: hit.heading,
      anchor: hit.anchor,
      excerpt: hit.excerpt.map((part) => part.text).join(''),
      url: manualWebUrl(language, hit.slug, hit.anchor ?? ''),
    }));
    return {
      locale: language,
      query: text,
      results,
      ...(results.length === 0 && {
        hint: 'No page contains every word. Try fewer or other words, or the other language.',
      }),
    };
  }

  /** @param {{ slug?: unknown, anchor?: unknown, locale?: unknown }} [request] */
  function read({ slug, anchor, locale } = {}) {
    const reference = parsePageReference(slug);
    const language = normalizeManualLocale(locale ?? reference.locale ?? undefined);
    const wanted = typeof anchor === 'string' && anchor.trim()
      ? anchor.trim().replace(/^#/, '')
      : reference.anchor;
    const { pages } = manual.getIndex(language);
    if (!Object.hasOwn(pages, reference.slug)) {
      return {
        error: `There is no manual page "${reference.slug}". Find it with search_manual, or use one of these slugs.`,
        slugs: Object.keys(pages),
      };
    }
    const page = manual.getPage(language, reference.slug);
    const sections = pageSections(page.markdown, { lexer: lex(), slugify: headingSlug });
    const headings = sections.filter((section) => section.anchor);

    let selected = sections;
    /** @type {string | null} */
    let section = null;
    if (wanted) {
      const at = sections.findIndex((entry) => entry.anchor === wanted);
      if (at === -1) {
        return {
          error: `The page "${reference.slug}" has no section "${wanted}".`,
          sections: headings.map(({ heading, anchor: id }) => ({ heading, anchor: id })),
        };
      }
      // The section with everything below it, up to the next heading of its level.
      const { depth } = sections[at];
      let end = at + 1;
      while (end < sections.length && sections[end].depth > depth) end += 1;
      selected = sections.slice(at, end);
      section = sections[at].heading;
    }

    const raw = selected.flatMap((entry) => entry.tokens).map((token) => token.raw).join('');
    let markdown = forTheModel(raw, language, reference.slug);
    const truncated = markdown.length > MAX_PAGE_CHARS;
    if (truncated) {
      const cut = markdown.lastIndexOf('\n', MAX_PAGE_CHARS);
      markdown = `${markdown.slice(0, cut > 0 ? cut : MAX_PAGE_CHARS)}\n\n…`;
    }

    return {
      locale: language,
      slug: reference.slug,
      title: page.title,
      description: page.description,
      ...(section ? { section, anchor: wanted } : {}),
      url: manualWebUrl(language, reference.slug, section ? wanted ?? '' : ''),
      markdown,
      // Only when the rest is missing: then the model can ask for a section.
      ...(truncated && {
        truncated: true,
        sections: headings.map(({ heading, anchor: id }) => ({ heading, anchor: id })),
      }),
    };
  }

  return { isAvailable, search, read };
}

module.exports = {
  createManualLookup,
  loadVendoredMarkedLexer,
  parsePageReference,
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_PAGE_CHARS,
};
