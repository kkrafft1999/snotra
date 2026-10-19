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

const { MANUAL_WEB_BASE, manualWebUrl: webUrl } = require('../../shared/manual/manual-address');
const { DEFAULT_LOCALE, isLocale } = require('../../shared/i18n/locales');

const THEMES = Object.freeze(['light', 'dark']);
const MOTIF = /^[a-z0-9-]+$/;

/**
 * @param {unknown} locale
 * @returns {string}
 */
function normalizeManualLocale(locale) {
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

/**
 * Address of a page on docs.snotra-ai.dev — every language but the root one lives under `/<code>/`.
 *
 * @param {unknown} locale
 * @param {string} [slug]
 * @param {string} [fragment]
 */
function manualWebUrl(locale, slug = 'index', fragment = '') {
  return webUrl(normalizeManualLocale(locale), slug, fragment);
}

/**
 * The bundle's `index.json`. A page's entry carries what the pages list shows
 * (`title`, `description`, `chapter`) and whatever else the bundler wrote.
 *
 * @typedef {{ title?: string, description?: string, chapter?: string|null } & Record<string, unknown>} ManualPageEntry
 * @typedef {{ locales: Record<string, { nav?: unknown, pages: Record<string, ManualPageEntry> }> }} ManualIndex
 */

/**
 * @param {object} deps
 * @param {Pick<typeof import('fs'), 'readFileSync'>} deps.fs
 * @param {Pick<typeof import('path'), 'join'>} deps.path
 * @param {string} deps.bundleDir
 */
function createManualService({ fs, path, bundleDir }) {
  /** @type {ManualIndex | null} */
  let index = null;

  function loadIndex() {
    if (index) return index;
    const raw = fs.readFileSync(path.join(bundleDir, 'index.json'), 'utf8');
    /** @type {ManualIndex} */
    const loaded = JSON.parse(raw);
    index = loaded;
    return loaded;
  }

  /** @param {unknown} locale */
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

  /** @param {unknown} locale */
  function getIndex(locale) {
    const { nav, pages } = localeIndex(locale);
    return { locale: normalizeManualLocale(locale), nav, pages };
  }

  /**
   * @param {unknown} locale
   * @param {unknown} slug
   */
  function getPage(locale, slug) {
    const normalized = normalizeManualLocale(locale);
    const { pages } = localeIndex(normalized);
    if (typeof slug !== 'string' || !Object.hasOwn(pages, slug)) {
      throw new Error(`No manual page "${slug}".`);
    }
    const markdown = fs.readFileSync(path.join(bundleDir, 'pages', normalized, `${slug}.md`), 'utf8');
    return { slug, ...pages[slug], markdown };
  }

  /**
   * Every page of a language at once — the search indexes them in the window (#847).
   *
   * @param {unknown} locale
   */
  function getAllPages(locale) {
    const normalized = normalizeManualLocale(locale);
    return Object.keys(localeIndex(normalized).pages).map((slug) => getPage(normalized, slug));
  }

  /**
   * @param {unknown} motif
   * @param {unknown} locale
   * @param {unknown} theme
   */
  function getScreenshot(motif, locale, theme) {
    if (typeof motif !== 'string' || !MOTIF.test(motif)) throw new Error('Invalid screenshot motif.');
    const variant = `${motif}.${normalizeManualLocale(locale)}.${THEMES.includes(theme) ? theme : 'light'}.webp`;
    const bytes = fs.readFileSync(path.join(bundleDir, 'screenshots', variant));
    return `data:image/webp;base64,${bytes.toString('base64')}`;
  }

  return { isAvailable, getIndex, getPage, getAllPages, getScreenshot };
}

module.exports = {
  createManualService,
  manualWebUrl,
  normalizeManualLocale,
  MANUAL_WEB_BASE,
};
