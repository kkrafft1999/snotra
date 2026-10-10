/**
 * Addresses inside the bundled user manual (#790).
 *
 * The pages are written for the web manual, so a link between two pages is a
 * Starlight address — `../../safety/sandbox/`, relative to the page's own
 * `/safety/choose-a-mode/`. The help window has no such addresses; it knows
 * pages by slug (`safety/sandbox`, `index` for the overview). This module turns
 * one into the other, the same way for both languages: a German page links
 * within `/de/`, so resolving it against the slug without the prefix lands on
 * the same slug.
 */

const BASE = 'https://manual.invalid';

/** A page's address on the web manual, relative to the language root. */
export function pagePathOf(slug) {
  return !slug || slug === 'index' ? '/' : `/${slug}/`;
}

/**
 * The slug a link of the page `fromSlug` points to, or null when it names no
 * page of the manual. `target` is the link without its `#fragment`.
 */
export function resolveManualLink(target, fromSlug, pages) {
  if (typeof target !== 'string') return null;
  let url;
  try {
    url = new URL(target, `${BASE}${pagePathOf(fromSlug)}`);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const slug = pathname
    .replace(/^\/+|\/+$/g, '')
    .replace(/^de(?:\/|$)/, '')
    .replace(/\.md$/, '')
    .replace(/(?:^|\/)index$/, '')
    || 'index';
  return pages && Object.hasOwn(pages, slug) ? slug : null;
}

/** `screenshots/mode-menu.webp` → `mode-menu`; the help window picks the variant. */
const SCREENSHOT = /^(?:\.\/)?screenshots\/([a-z0-9-]+)\.webp$/;

export function screenshotMotif(src) {
  const match = typeof src === 'string' ? src.trim().match(SCREENSHOT) : null;
  return match ? match[1] : null;
}

/** `[since 1.17]` / `[seit 1.17]`, as the web manual's remark plugin reads it. */
export const SINCE_MARKER = /\[(?:since|seit) (\d+\.\d+(?:\.\d+)?)\]/gi;

/** The page on docs.snotra-ai.dev, for *Open on the web*. */
export function manualWebUrl(webBase, locale, slug, fragment = '') {
  const prefix = locale === 'de' ? 'de/' : '';
  const page = !slug || slug === 'index' ? '' : `${slug}/`;
  const hash = fragment ? `#${encodeURIComponent(fragment)}` : '';
  return `${webBase}${prefix}${page}${hash}`;
}
