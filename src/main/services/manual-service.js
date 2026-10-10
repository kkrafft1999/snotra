'use strict';

/**
 * Reads the user manual that ships with the app (#790).
 *
 * `scripts/bundle-manual.js` puts the pages, `index.json` and the screenshots
 * into `src/manual/`. This service is the only thing that reads from there,
 * and it reads nothing else: a page is looked up by its slug in the index, a
 * screenshot by its motif, language and theme — never by a path the help
 * window hands over.
 */

const LOCALES = Object.freeze(['en', 'de']);
const DEFAULT_LOCALE = 'en';
const THEMES = Object.freeze(['light', 'dark']);
const MOTIF = /^[a-z0-9-]+$/;

/** The web manual, for *Open on the web* and as the fallback without a bundle. */
const MANUAL_WEB_BASE = 'https://docs.snotra-ai.dev/';

function normalizeManualLocale(locale) {
  return LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
}

/** Address of a page on docs.snotra-ai.dev — the German pages live under `/de/`. */
function manualWebUrl(locale, slug = 'index', fragment = '') {
  const prefix = normalizeManualLocale(locale) === 'de' ? 'de/' : '';
  const page = !slug || slug === 'index' ? '' : `${slug}/`;
  const hash = fragment ? `#${encodeURIComponent(fragment)}` : '';
  return `${MANUAL_WEB_BASE}${prefix}${page}${hash}`;
}

function createManualService({ fs, path, bundleDir }) {
  let index = null;

  function loadIndex() {
    if (index) return index;
    const raw = fs.readFileSync(path.join(bundleDir, 'index.json'), 'utf8');
    index = JSON.parse(raw);
    return index;
  }

  function localeIndex(locale) {
    return loadIndex().locales[normalizeManualLocale(locale)];
  }

  /** Whether a bundled manual is there — without one the menu opens the web. */
  function isAvailable() {
    try {
      return Boolean(localeIndex(DEFAULT_LOCALE)?.pages?.index);
    } catch {
      return false;
    }
  }

  function getIndex(locale) {
    const { nav, pages } = localeIndex(locale);
    return { locale: normalizeManualLocale(locale), nav, pages };
  }

  function getPage(locale, slug) {
    const normalized = normalizeManualLocale(locale);
    const { pages } = localeIndex(normalized);
    if (typeof slug !== 'string' || !Object.hasOwn(pages, slug)) {
      throw new Error(`No manual page "${slug}".`);
    }
    const markdown = fs.readFileSync(path.join(bundleDir, 'pages', normalized, `${slug}.md`), 'utf8');
    return { slug, ...pages[slug], markdown };
  }

  function getScreenshot(motif, locale, theme) {
    if (typeof motif !== 'string' || !MOTIF.test(motif)) throw new Error('Invalid screenshot motif.');
    const variant = `${motif}.${normalizeManualLocale(locale)}.${THEMES.includes(theme) ? theme : 'light'}.webp`;
    const bytes = fs.readFileSync(path.join(bundleDir, 'screenshots', variant));
    return `data:image/webp;base64,${bytes.toString('base64')}`;
  }

  return { isAvailable, getIndex, getPage, getScreenshot };
}

module.exports = {
  createManualService,
  manualWebUrl,
  normalizeManualLocale,
  MANUAL_WEB_BASE,
};
