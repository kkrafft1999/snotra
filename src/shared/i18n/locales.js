'use strict';

/**
 * The languages the app speaks, and what is known about each (AR-32, #1007).
 *
 * This is the registration point: a new language is a new catalogue under
 * `messages/` plus one entry here and one value in `APP_LOCALES`
 * (`contracts/enums.js`) — and nothing else in the code names a language.
 * Everything that used to branch on `de` / `en` — the plural rule, the
 * language of speech recognition, the label in the settings, the language
 * folder of the manual — reads it from this list. `test/locale-literals.test.js`
 * fails on a literal that slips in anyway.
 *
 * The catalogues themselves stay flat `key → string` maps; what describes the
 * language rather than a sentence lives beside them, in the entries below.
 */

const { APP_LOCALES } = require('../contracts/enums');
const de = require('./messages/de');
const en = require('./messages/en');

/**
 * One entry per language, in the order they are offered in the settings.
 *
 * - `name`: the language in its own words — a reader who cannot read the
 *   current interface language still finds theirs.
 * - `speechLanguage`: the code the speech recognition is asked for
 *   (ISO 639-1, as OpenAI's transcription endpoints take it).
 * - `messages`: the catalogue.
 */
/**
 * A catalogue as the lookups see it: a flat `key → string` map, whatever keys
 * the two literals below happen to have today.
 *
 * @typedef {Readonly<Record<string, string>>} Catalogue
 */

/** @type {ReadonlyArray<Readonly<{ code: string, name: string, speechLanguage: string, messages: Catalogue }>>} */
const CATALOGUES = Object.freeze([
  Object.freeze({ code: APP_LOCALES.EN, name: 'English', speechLanguage: 'en', messages: en }),
  Object.freeze({ code: APP_LOCALES.DE, name: 'Deutsch', speechLanguage: 'de', messages: de }),
]);

/**
 * The language the source version is written in, and the one a lookup falls
 * back to. Fresh installations start here (epic #277); existing ones stay on
 * German — but that is decided by the store when it reads the preferences, not
 * by this module.
 *
 * Typed as a plain string: it is the default of every `locale` parameter,
 * and those take whatever language the preferences hold.
 * @type {string}
 */
const DEFAULT_LOCALE = APP_LOCALES.EN;

/**
 * The language of installations from before the language was a setting (#277).
 * Where no language is known at all — no getter wired, a value that names no
 * registered language — voice input keeps asking for it, as it always did.
 */
const LEGACY_LOCALE = APP_LOCALES.DE;

/** Every supported language, in the order they are offered. */
const LOCALES = Object.freeze(CATALOGUES.map((entry) => entry.code));

/** @type {Readonly<Record<string, Catalogue>>} */
const MESSAGES = Object.freeze(Object.fromEntries(CATALOGUES.map((entry) => [entry.code, entry.messages])));

/** @type {Map<string, (typeof CATALOGUES)[number]>} */
const ENTRIES = new Map(CATALOGUES.map((entry) => [entry.code, entry]));

/** @param {string} code */
function entryOf(code) {
  const entry = ENTRIES.get(code);
  if (!entry) throw new Error(`The language "${code}" is not registered.`);
  return entry;
}

const LEGACY_ENTRY = entryOf(LEGACY_LOCALE);

/** `{ code, name, speechLanguage }` of every language, for lists and pickers. */
const LOCALE_INFO = Object.freeze(
  CATALOGUES.map(({ code, name, speechLanguage }) => Object.freeze({ code, name, speechLanguage }))
);

/**
 * Is this the code of a registered language? Exact — no case folding, no region.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isLocale(value) {
  return typeof value === 'string' && ENTRIES.has(value);
}

/**
 * The language in its own words, or the code itself for one that is not registered.
 *
 * @param {string} locale
 */
function localeName(locale) {
  return ENTRIES.get(locale)?.name ?? String(locale);
}

/**
 * The language voice input asks the speech recognition for. A language that is
 * not registered gets the legacy one — a guess, but the one the app always made.
 *
 * @param {string} locale
 */
function speechLanguageFor(locale) {
  return (ENTRIES.get(locale) ?? LEGACY_ENTRY).speechLanguage;
}

/**
 * Does a language code, as voice input receives it from a caller, name a
 * language speech recognition is known to handle?
 *
 * @param {unknown} value
 */
function isSpeechLanguage(value) {
  return CATALOGUES.some((entry) => entry.speechLanguage === value);
}

/**
 * Address prefix of a language's pages in the web manual: the root of the site
 * is written in the default language and carries none, every other language
 * lives under `<code>/` — `de/` for German.
 *
 * @param {string} locale
 */
function manualPathPrefix(locale) {
  return isLocale(locale) && locale !== DEFAULT_LOCALE ? `${locale}/` : '';
}

/**
 * Splits a manual path (no leading slash) into the language its first segment
 * names and the rest. `locale` is null for the root language, which has no
 * segment — `de/safety/sandbox` → `{ locale: 'de', rest: 'safety/sandbox' }`,
 * `safety/sandbox` → `{ locale: null, rest: 'safety/sandbox' }`.
 *
 * @param {string} path
 * @returns {{ locale: string|null, rest: string }}
 */
function splitManualLocale(path) {
  const slash = path.indexOf('/');
  const first = slash === -1 ? path : path.slice(0, slash);
  if (first === DEFAULT_LOCALE || !isLocale(first)) return { locale: null, rest: path };
  return { locale: first, rest: slash === -1 ? '' : path.slice(slash + 1).replace(/^\/+/, '') };
}

module.exports = {
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
};
