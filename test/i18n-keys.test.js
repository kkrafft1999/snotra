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
  translateMessage,
  translatePlural,
} = require('../src/shared/i18n');
const contracts = require('../src/shared/contracts');
const { createMessage } = require('../src/shared/contracts/message');

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
  // Nothing but two placeholders and the server's own text between them —
  // there is no wording here to translate (#291).
  'tools.mcp.short',
  // "Status" is the German word too, and the value is that word plus a
  // placeholder (#290).
  'approval.audit.status',
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
  // happens over whole keys. `createMessage('…')` belongs in the list since
  // #293: the contracts name their keys the same way, only far from the place
  // that shows them.
  const literal = /\b(t|tPlural|translate|translateMessage|translatePlural|createMessage)\(\s*'([\w.]+)'/g;
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

/**
 * The contracts reach for the catalogue through tables as well, and a table is
 * invisible to the text scan above (issue #293). Every value in them is a key
 * and has to exist — otherwise the interface quietly prints
 * `toolPermission.denied.…` where a sentence belongs.
 */
test('the key tables of the contract layer point at existing entries', () => {
  const tables = {
    PERMISSION_DENIED_MESSAGE_KEYS: contracts.PERMISSION_DENIED_MESSAGE_KEYS,
    WORKSPACE_IMAGE_ERROR_MESSAGE_KEYS:
      require('../src/shared/contracts/workspace-image').WORKSPACE_IMAGE_ERROR_MESSAGE_KEYS,
    MEMORY_SCOPE_LABEL_KEYS: contracts.MEMORY_SCOPE_LABEL_KEYS,
  };
  const missing = [];
  for (const [name, table] of Object.entries(tables)) {
    assert.ok(table && Object.keys(table).length > 0, `${name} is empty`);
    for (const [entry, key] of Object.entries(table)) {
      if (!Object.prototype.hasOwnProperty.call(MESSAGES[DEFAULT_LOCALE], key)) {
        missing.push(`${name}.${entry}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'key table points at an entry that does not exist');
});

/**
 * The tool lines of the chat log name their base key in a table too (#290) —
 * four sentences hang below each one, and none of them is visible to the text
 * scan above. Missing one means a raw `tools.line.…` in the middle of the log.
 */
test('every tool line carries all four sentences', () => {
  const { LINE_VARIANTS, TOOL_LINE_KEYS } = require('../src/shared/presentation/tool-display');
  const missing = [];
  for (const [tool, base] of Object.entries(TOOL_LINE_KEYS)) {
    for (const variant of LINE_VARIANTS) {
      const key = `${base}.${variant}`;
      if (!Object.prototype.hasOwnProperty.call(MESSAGES[DEFAULT_LOCALE], key)) {
        missing.push(`${tool}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'tool line without a sentence in the catalogue');
});

/**
 * A message descriptor is only worth anything if the display side can put it
 * into words — in both languages, and with its placeholders filled.
 */
test('a message descriptor is translated, plain text passes through', () => {
  const message = createMessage('mcp.error.idTooLong', { max: 64 });
  assert.equal(translateMessage('en', message), 'The identifier may be at most 64 characters long.');
  assert.equal(translateMessage('de', message), 'Die Kennung darf höchstens 64 Zeichen lang sein.');
  assert.equal(createTranslator('de').message(message), translateMessage('de', message));
  // Layers that have not been converted yet still hand over finished text.
  assert.equal(translateMessage('de', 'schon fertig'), 'schon fertig');
  assert.equal(translateMessage('de', null), '');
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
