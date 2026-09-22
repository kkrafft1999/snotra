const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGES,
  createTranslator,
  normalizeLocale,
  translate,
  translatePlural,
} = require('../src/shared/i18n');

const SRC = path.join(__dirname, '..', 'src');

/**
 * The counterpart to `test/website-i18n.test.js` for the app (epic #277).
 * Without it a gap only shows once somebody switches the language and finds
 * English sentences left standing in a German interface — exactly the failure
 * mode of issue #118.
 */

test('every language carries exactly the same keys', () => {
  const reference = Object.keys(MESSAGES[DEFAULT_LOCALE]).sort();
  for (const locale of LOCALES) {
    const keys = Object.keys(MESSAGES[locale]).sort();
    const missing = reference.filter((key) => !keys.includes(key));
    const orphans = keys.filter((key) => !reference.includes(key));
    assert.deepEqual(missing, [], `${locale}: missing keys`);
    assert.deepEqual(orphans, [], `${locale}: orphaned keys`);
  }
});

/**
 * What reads the same in both languages because it has to — "Version" is
 * spelled alike in English and German. Keep the list short: every entry is a
 * place where this test stops paying attention.
 */
const IDENTICAL_ON_PURPOSE = new Set([
  'settings.version.known',
  'settings.version.unknown',
]);

test('no value is empty, and none was left identical in both languages by accident', () => {
  const suspicious = [];
  for (const [key, value] of Object.entries(MESSAGES.en)) {
    assert.equal(typeof value, 'string', `${key} is not a string`);
    assert.notEqual(value.trim(), '', `${key} is empty`);
    // Proper nouns, abbreviations and bare punctuation may match; anything
    // longer points at a forgotten translation.
    if (MESSAGES.de[key] === value && value.length > 12 && !IDENTICAL_ON_PURPOSE.has(key)) {
      suspicious.push(key);
    }
  }
  assert.deepEqual(suspicious, [], 'identical in both languages — translated?');
});

test('placeholders match across the languages', () => {
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(MESSAGES[DEFAULT_LOCALE])) {
    assert.deepEqual(
      names(MESSAGES.de[key]),
      names(MESSAGES.en[key]),
      `${key}: placeholders differ`
    );
  }
});

test('every key used in the code exists', () => {
  const files = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // `generated/` is the built bundle, `vendor/` is third-party code.
        if (entry.name === 'generated' || entry.name === 'vendor') continue;
        collect(full);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.html')) {
        files.push(full);
      }
    }
  };
  collect(SRC);

  // `t('…')`, `tPlural('…')`, `data-i18n="…"` — literals only. A key assembled
  // from parts escapes this check, which is why the code has none: branching
  // happens over whole keys.
  const literal = /\b(t|tPlural|translate|translatePlural)\(\s*'([\w.]+)'/g;
  const attribute = /data-i18n(?:-html)?="([\w.]+)"/g;
  const attrPair = /data-i18n-attr="([^"]+)"/g;

  const missing = new Set();
  const knows = (key) => Object.prototype.hasOwnProperty.call(MESSAGES[DEFAULT_LOCALE], key);
  // A plural call names the stem; the catalogue holds `.one` / `.other`.
  const knowsPlural = (key) => knows(`${key}.one`) && knows(`${key}.other`);

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(literal)) {
      const [, fn, key] = m;
      // `translate(locale, key)` has the key in second place — a match without
      // a dot is the locale there, not a key.
      if (!key.includes('.')) continue;
      const ok = fn.endsWith('Plural') ? knowsPlural(key) : knows(key);
      if (!ok) missing.add(`${path.relative(SRC, file)}: ${key}`);
    }
    for (const m of text.matchAll(attribute)) {
      if (!knows(m[1])) missing.add(`${path.relative(SRC, file)}: ${m[1]}`);
    }
    for (const m of text.matchAll(attrPair)) {
      for (const pair of m[1].split(';')) {
        const key = pair.split(':')[1]?.trim();
        if (key && !knows(key)) missing.add(`${path.relative(SRC, file)}: ${key}`);
      }
    }
  }
  assert.deepEqual([...missing], [], 'key used in the code but missing from the catalogue');
});

test('English is the default; anything unknown falls back to it', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(normalizeLocale('de'), 'de');
  assert.equal(normalizeLocale('DE'), 'de');
  assert.equal(normalizeLocale('de-DE'), 'en');
  assert.equal(normalizeLocale(undefined), 'en');
  assert.equal(normalizeLocale(42), 'en');
});

test('placeholders are filled in, missing ones stay visible', () => {
  assert.equal(translate('de', 'settings.version.known', { version: '1.7.6' }), 'Version 1.7.6');
  // A visible placeholder beats the word "undefined" in the middle of a sentence.
  assert.equal(translate('de', 'settings.version.known', {}), 'Version {version}');
});

test('an unknown key yields the key, not German', () => {
  assert.equal(translate('en', 'gibt.es.nicht'), 'gibt.es.nicht');
  assert.equal(translate('de', ''), '');
});

test('singular and plural follow the counter', () => {
  assert.equal(translatePlural('en', 'settings.memory.entries', 1), '1 entry');
  assert.equal(translatePlural('en', 'settings.memory.entries', 3), '3 entries');
  assert.equal(translatePlural('de', 'settings.memory.entries', 1), '1 Eintrag');
  assert.equal(translatePlural('de', 'settings.memory.entries', 0), '0 Einträge');
});

test('the bound translator speaks its language', () => {
  const t = createTranslator('de');
  assert.equal(t.locale, 'de');
  assert.equal(t('settings.title'), 'Einstellungen');
  assert.equal(t.plural('settings.memory.entries', 2), '2 Einträge');
  assert.equal(createTranslator('en')('settings.title'), 'Settings');
});
