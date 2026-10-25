'use strict';

/**
 * Interface strings in every registered language (epic #277) — today English
 * and German; the registry is `locales.js`.
 *
 * One place for everything a human reads — renderer, main process and contracts
 * all reach for the same catalogue. What goes to the *model* explicitly does
 * not belong here: that channel has been English since #276 and is guarded by
 * `test/model-prompt-language.test.js`.
 *
 * Per `.claude/rules/language.md`, English is the source version and German is
 * derived from it — `en.js` is written, `de.js` is translated, and both are
 * held to the same standard. When a key is missing, the lookup falls back to
 * `DEFAULT_LOCALE` and finally to the key itself — a raw key in the English
 * interface is noticed, a German sentence in it would not be (see
 * `docs/architecture/architecture.md`, "One catalogue for all three layers"). A key missing
 * only from `de.js` therefore reads as English, which is why it never gets that
 * far: `test/i18n-keys.test.js` keeps both catalogues on the same keys.
 */

const { APP_LOCALES } = require('../contracts/enums');
const { isMessage } = require('../contracts/message');
const {
  DEFAULT_LOCALE,
  LEGACY_LOCALE,
  LOCALES,
  LOCALE_INFO,
  MESSAGES,
  isLocale,
  isSpeechLanguage,
  localeName,
  manualPathPrefix,
  speechLanguageFor,
  splitManualLocale,
} = require('./locales');

/**
 * Anything not in the list is not a language — `de-DE` is not, while `EN` is
 * read as `en`: case says nothing, a region would claim more than the
 * catalogue has. The value comes from a file on disk and is not taken on trust.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeLocale(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

/**
 * The app language for the system's locale (#1013): `de-DE`, `de_AT` and `de`
 * all mean German, and a language the app does not speak means the default.
 * Unlike `normalizeLocale` this one reads the language off a full tag — it
 * is given what the operating system reports, not what the app wrote itself.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function localeFromSystem(raw) {
  const language = typeof raw === 'string' ? raw.trim().toLowerCase().split(/[-_]/)[0] : '';
  return LOCALES.includes(language) ? language : DEFAULT_LOCALE;
}

/**
 * Placeholders of the form `{name}`. A missing value leaves the placeholder
 * standing rather than printing `undefined` — the first is noticed at a glance,
 * the second reads like text.
 *
 * @param {string} template
 * @param {Record<string, unknown>} [params]
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
 * @param {string} locale  A registered language; anything else counts as DEFAULT_LOCALE.
 * @param {string} key     Dotted key, e.g. `settings.nav.general`.
 * @param {Record<string, unknown>} [params] Values for `{placeholders}`.
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

/** @type {Map<string, Intl.PluralRules>} */
const pluralRules = new Map();

/**
 * The plural rule of a language, from the platform's CLDR data — one per language.
 *
 * @param {string} locale
 */
function pluralRulesFor(locale) {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules;
}

/**
 * The form of `baseKey` for `count`: `key.one`, `key.other` — and, for a
 * language that distinguishes more, `key.few`, `key.many`, `key.two`,
 * `key.zero` (the CLDR categories of `Intl.PluralRules`). A catalogue that has
 * no entry for the category its language asks for falls back to `key.other`.
 * The counter travels along as `{count}` automatically, so the common case
 * costs nothing at the call site.
 *
 * @param {unknown} locale
 * @param {string} baseKey
 * @param {unknown} count
 * @param {Record<string, unknown>} [params]
 */
function translatePlural(locale, baseKey, count, params) {
  const lc = normalizeLocale(locale);
  let suffix = pluralRulesFor(lc).select(Math.abs(Number(count)));
  if (suffix !== 'other' && typeof MESSAGES[lc][`${baseKey}.${suffix}`] !== 'string') suffix = 'other';
  return translate(lc, `${baseKey}.${suffix}`, { count, ...params });
}

/**
 * Parameters that are themselves catalogue keys (#290). A layer far from the
 * screen — the permission planner, say — knows *which* mode or which risk
 * classes belong in the sentence, but not what they are called in the language
 * the card is being read in. By convention it names them `…Key` (one) or
 * `…Keys` (several); both are looked up here and put in under the bare name,
 * so the entry itself only ever sees `{mode}` or `{effect}`. A number named
 * `…Time` is a point in time in epoch ms and comes out as a clock time.
 *
 * @param {string} locale
 * @param {Record<string, unknown>} [params]
 */
function resolveKeyParams(locale, params) {
  if (!params) return params;
  let out = params;
  for (const [name, value] of Object.entries(params)) {
    // A whole message as a value (#308): a sentence that wraps another one —
    // "{reason} The other settings have been saved." — gets the inner one in
    // the same language as itself.
    if (isMessage(value)) {
      if (out === params) out = { ...params };
      out[name] = translateMessage(locale, value);
    } else if (name.endsWith('Time') && typeof value === 'number' && Number.isFinite(value)) {
      // A point in time as epoch ms (#943): the sentence is built far from the
      // screen, the clock format belongs to the language it is read in.
      if (out === params) out = { ...params };
      out[name] = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(value);
    } else if (name.endsWith('Keys') && Array.isArray(value)) {
      if (out === params) out = { ...params };
      out[name.slice(0, -4)] = value.map((key) => translate(locale, key)).join(', ');
      delete out[name];
    } else if (name.endsWith('Key') && typeof value === 'string') {
      if (out === params) out = { ...params };
      out[name.slice(0, -3)] = translate(locale, value);
      delete out[name];
    }
  }
  return out;
}

/**
 * A message descriptor from the contract layer (`createMessage`) put into
 * words. Plain text passes through untouched — since #308 that is only ever
 * quoted material: the error text of a provider's API, a network error, a
 * message from a third-party library. Snotra's own sentences travel as keys.
 *
 * @param {string} locale
 * @param {unknown} message  A `Message` descriptor or plain text.
 * @returns {string}
 */
function translateMessage(locale, message) {
  if (isMessage(message)) return translate(locale, message.key, resolveKeyParams(locale, message.params));
  return typeof message === 'string' ? message : '';
}

/**
 * Does this key exist at all? For tests and debug output.
 *
 * @param {string} key
 */
function hasKey(key) {
  return Object.prototype.hasOwnProperty.call(MESSAGES[DEFAULT_LOCALE], key);
}

/**
 * A translator bound to one language. Saves threading the locale through every
 * function — the main process builds one per language change in
 * `create-application`, the renderer keeps one in `i18n.js`.
 *
 * @param {unknown} [locale]  none: the default language
 */
function createTranslator(locale) {
  const lc = normalizeLocale(locale);
  /**
   * @param {string} key
   * @param {Record<string, unknown>} [params]
   */
  const t = (key, params) => translate(lc, key, params);
  /**
   * @param {string} baseKey
   * @param {unknown} count
   * @param {Record<string, unknown>} [params]
   */
  t.plural = (baseKey, count, params) => translatePlural(lc, baseKey, count, params);
  /** @param {unknown} message */
  t.message = (message) => translateMessage(lc, message);
  t.locale = lc;
  return t;
}

module.exports = {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LEGACY_LOCALE,
  LOCALES,
  LOCALE_INFO,
  MESSAGES,
  createTranslator,
  hasKey,
  isLocale,
  isSpeechLanguage,
  localeFromSystem,
  localeName,
  manualPathPrefix,
  normalizeLocale,
  speechLanguageFor,
  splitManualLocale,
  translate,
  translateMessage,
  translatePlural,
};
