'use strict';

/**
 * Interface strings in two languages (epic #277).
 *
 * One place for everything a human reads — renderer, main process and contracts
 * all reach for the same catalogue. What goes to the *model* explicitly does
 * not belong here: that channel has been English since #276 and is guarded by
 * `test/model-prompt-language.test.js`.
 *
 * Per `.claude/rules/language.md`, English is the source version and German is
 * derived from it — `en.js` is written, `de.js` is translated, and both are
 * held to the same standard. When a key is missing, the lookup falls back to
 * `DEFAULT_LOCALE` and finally to the key itself: visibly wrong beats silently
 * English in a German app. That it never gets that far is what
 * `test/i18n-keys.test.js` is for.
 */

const { APP_LOCALES } = require('../contracts/enums');
const de = require('./messages/de');
const en = require('./messages/en');

/**
 * The app's runtime default. Fresh installations start here (epic #277);
 * existing ones stay on German — but that is decided by the store when it reads
 * the preferences, not by this module.
 */
const DEFAULT_LOCALE = APP_LOCALES.EN;

const MESSAGES = Object.freeze({
  [APP_LOCALES.DE]: de,
  [APP_LOCALES.EN]: en,
});

/** Every supported language, in the order they are offered. */
const LOCALES = Object.freeze([APP_LOCALES.DE, APP_LOCALES.EN]);

/**
 * Anything not in the list is not a language — not `de-DE` and not `EN`. The
 * value comes from a file on disk and is not taken on trust.
 */
function normalizeLocale(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

/**
 * Placeholders of the form `{name}`. A missing value leaves the placeholder
 * standing rather than printing `undefined` — the first is noticed at a glance,
 * the second reads like text.
 */
function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

/**
 * One string in the requested language.
 *
 * @param {string} locale  `de` or `en`; anything else counts as DEFAULT_LOCALE.
 * @param {string} key     Dotted key, e.g. `settings.nav.general`.
 * @param {object} [params] Values for `{placeholders}`.
 */
function translate(locale, key, params) {
  if (typeof key !== 'string' || !key) return '';
  const lc = normalizeLocale(locale);
  const direct = MESSAGES[lc][key];
  if (typeof direct === 'string') return interpolate(direct, params);
  const fallback = MESSAGES[DEFAULT_LOCALE][key];
  if (typeof fallback === 'string') return interpolate(fallback, params);
  return key;
}

/**
 * Two forms are enough for English and German: `key.one` and `key.other`. The
 * counter travels along as `{count}` automatically, so the common case costs
 * nothing at the call site.
 */
function translatePlural(locale, baseKey, count, params) {
  const suffix = Math.abs(Number(count)) === 1 ? 'one' : 'other';
  return translate(locale, `${baseKey}.${suffix}`, { count, ...params });
}

/** Does this key exist at all? For tests and debug output. */
function hasKey(key) {
  return Object.prototype.hasOwnProperty.call(MESSAGES[DEFAULT_LOCALE], key);
}

/**
 * A translator bound to one language. Saves threading the locale through every
 * function — the main process builds one per language change in
 * `create-application`, the renderer keeps one in `i18n.js`.
 */
function createTranslator(locale) {
  const lc = normalizeLocale(locale);
  const t = (key, params) => translate(lc, key, params);
  t.plural = (baseKey, count, params) => translatePlural(lc, baseKey, count, params);
  t.locale = lc;
  return t;
}

module.exports = {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGES,
  createTranslator,
  hasKey,
  normalizeLocale,
  translate,
  translatePlural,
};
