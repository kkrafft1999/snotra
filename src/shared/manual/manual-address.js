'use strict';

/**
 * Addresses of the web manual on docs.snotra-ai.dev, both ways.
 *
 * The model hands the user these addresses (`read_manual_page`, #947), and a
 * click on one in the chat opens the bundled manual in the help window rather
 * than the browser — the pages of the installed version, not the latest. Main
 * and renderer read the same rule from here.
 */

const { manualPathPrefix, splitManualLocale } = require('../i18n/locales');

/** The web manual, for *Open on the web* and as the fallback without a bundle. */
const MANUAL_WEB_BASE = 'https://docs.snotra-ai.dev/';
const MANUAL_HOST = 'docs.snotra-ai.dev';
const SLUG = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

/** Address of a page on docs.snotra-ai.dev — every language but the root one lives under `/<code>/`. */
function manualWebUrl(locale, slug = 'index', fragment = '') {
  const prefix = manualPathPrefix(locale);
  const page = !slug || slug === 'index' ? '' : `${slug}/`;
  const hash = fragment ? `#${encodeURIComponent(fragment)}` : '';
  return `${MANUAL_WEB_BASE}${prefix}${page}${hash}`;
}

/**
 * `{ slug, fragment, locale }` of a page address on docs.snotra-ai.dev, or null
 * for anything else — another host, plain http, a file, an address that names
 * no page. `locale` is the language of a page under `/<code>/` and null for the root one.
 */
function parseManualAddress(href) {
  let url;
  try {
    url = new URL(String(href ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== MANUAL_HOST || url.port || url.username || url.password) {
    return null;
  }
  let pathname;
  let fragment;
  try {
    pathname = decodeURIComponent(url.pathname);
    fragment = decodeURIComponent(url.hash.replace(/^#/, ''));
  } catch {
    return null;
  }
  const { locale, rest: path } = splitManualLocale(pathname.replace(/^\/+|\/+$/g, ''));
  const slug = path.replace(/\.md$/, '').replace(/(?:^|\/)index$/, '') || 'index';
  if (!SLUG.test(slug)) return null;
  return { slug, fragment, locale };
}

module.exports = {
  MANUAL_WEB_BASE,
  manualWebUrl,
  parseManualAddress,
};
