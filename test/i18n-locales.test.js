'use strict';

// What a language knows about itself (AR-32, #1007): plural form, speech
// language, name, address of its manual pages. `test/locale-literals.test.js`
// keeps the code from answering these questions on its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_LOCALE,
  LEGACY_LOCALE,
  LOCALES,
  isLocale,
  isSpeechLanguage,
  localeName,
  manualPathPrefix,
  speechLanguageFor,
  splitManualLocale,
  translatePlural,
  MESSAGES,
} = require('../src/shared/i18n');

test('the plural form comes from the language\'s own rule', () => {
  const { translate } = require('../src/shared/i18n');
  // Any `.one` / `.other` pair of the catalogue will do.
  const base = Object.keys(MESSAGES[DEFAULT_LOCALE]).find((key) => key.endsWith('.one')).slice(0, -4);
  for (const locale of LOCALES) {
    assert.equal(translatePlural(locale, base, 1), translate(locale, `${base}.one`, { count: 1 }));
    assert.equal(translatePlural(locale, base, -1), translate(locale, `${base}.one`, { count: -1 }));
    assert.equal(translatePlural(locale, base, 0), translate(locale, `${base}.other`, { count: 0 }));
    assert.equal(translatePlural(locale, base, 2), translate(locale, `${base}.other`, { count: 2 }));
    assert.equal(translatePlural(locale, base, 1.5), translate(locale, `${base}.other`, { count: 1.5 }));
    assert.equal(translatePlural(locale, base, NaN), translate(locale, `${base}.other`, { count: NaN }));
  }
});

test('a category the catalogue has no entry for falls back to `.other`', () => {
  const { translate } = require('../src/shared/i18n');
  // `Intl.PluralRules` knows `zero`, `two`, `few`, `many` for other languages;
  // none of the registered ones has a key for them, and must not print the key.
  const base = Object.keys(MESSAGES[DEFAULT_LOCALE]).find((key) => key.endsWith('.other')).slice(0, -6);
  const originalSelect = Intl.PluralRules.prototype.select;
  Intl.PluralRules.prototype.select = () => 'few';
  try {
    for (const locale of LOCALES) {
      assert.equal(translatePlural(locale, base, 3), translate(locale, `${base}.other`, { count: 3 }));
    }
  } finally {
    Intl.PluralRules.prototype.select = originalSelect;
  }
});

test('speech recognition asks for the language of the interface', () => {
  assert.equal(speechLanguageFor(DEFAULT_LOCALE), 'en');
  assert.equal(speechLanguageFor(LEGACY_LOCALE), 'de');
  for (const locale of LOCALES) {
    assert.equal(isSpeechLanguage(speechLanguageFor(locale)), true, `${locale}: a speech language of its own`);
  }
  assert.equal(speechLanguageFor('fr'), speechLanguageFor(LEGACY_LOCALE), 'a language without a catalogue gets the legacy one');
  assert.equal(speechLanguageFor(undefined), speechLanguageFor(LEGACY_LOCALE));
  assert.equal(isSpeechLanguage(speechLanguageFor(DEFAULT_LOCALE)), true);
  assert.equal(isSpeechLanguage('fr'), false);
  assert.equal(isSpeechLanguage(undefined), false);
});

test('every language has a name of its own', () => {
  for (const locale of LOCALES) assert.notEqual(localeName(locale), locale);
  assert.equal(localeName('xx'), 'xx');
  assert.equal(isLocale(DEFAULT_LOCALE), true);
  assert.equal(isLocale('EN'), false);
});

test('the root language of the web manual has no prefix, the others their code', () => {
  assert.equal(manualPathPrefix(DEFAULT_LOCALE), '');
  assert.equal(manualPathPrefix('xx'), '');
  for (const locale of LOCALES.filter((code) => code !== DEFAULT_LOCALE)) {
    assert.equal(manualPathPrefix(locale), `${locale}/`);
    assert.deepEqual(splitManualLocale(locale), { locale, rest: '' });
    assert.deepEqual(splitManualLocale(`${locale}/`), { locale, rest: '' });
    assert.deepEqual(splitManualLocale(`${locale}/safety/sandbox`), { locale, rest: 'safety/sandbox' });
    assert.deepEqual(splitManualLocale(`${locale}x/safety`), { locale: null, rest: `${locale}x/safety` });
  }
  assert.deepEqual(splitManualLocale('safety/sandbox'), { locale: null, rest: 'safety/sandbox' });
  assert.deepEqual(splitManualLocale(`${DEFAULT_LOCALE}/safety`), { locale: null, rest: `${DEFAULT_LOCALE}/safety` });
});
