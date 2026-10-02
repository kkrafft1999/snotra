// Sizes just under a unit read in the next unit up (#650).
//
// Both formatters picked the unit before rounding: 1,048,575 B is 1023.999 KB,
// which one decimal printed as "1024.0 KB". The unit is now chosen after
// rounding, in the main process (format-bytes.js) and in the renderer
// (formatSize in helpers.js) alike.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer } = require('./helpers/dom.js');
const { formatBytes } = require('../src/shared/runtime/format-bytes.js');

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;

// [bytes, English, German]
const BOUNDARIES = [
  [1023, '1023 B', '1023 B'],
  [1023.6, '1.0 KB', '1,0 KB'],
  [KB, '1.0 KB', '1,0 KB'],
  // 1023.94 KB still rounds down; 1023.95 KB is the first to round up.
  [MB - 52, '1023.9 KB', '1023,9 KB'],
  [MB - 51, '1.0 MB', '1,0 MB'],
  [MB - 1, '1.0 MB', '1,0 MB'],
  [MB, '1.0 MB', '1,0 MB'],
  [GB - 1, '1.0 GB', '1,0 GB'],
  [GB, '1.0 GB', '1,0 GB'],
  [TB - 1, '1.0 TB', '1,0 TB'],
  [TB, '1.0 TB', '1,0 TB'],
  // There is no unit above TB to step up to.
  [1024 * TB - 1, '1024.0 TB', '1024,0 TB'],
];

const loadRenderer = async () => {
  const { formatSize } = await importRenderer('utils', 'helpers.js');
  const { setLocale } = await importRenderer('i18n.js');
  return { formatSize, setLocale };
};

test('formatBytes chooses the unit after rounding', () => {
  for (const [bytes, en, de] of BOUNDARIES) {
    assert.equal(formatBytes(bytes, 'en'), en, `en: ${bytes}`);
    assert.equal(formatBytes(bytes, 'de'), de, `de: ${bytes}`);
  }
});

test('the renderer formatSize chooses the unit after rounding', async () => {
  const { formatSize, setLocale } = await loadRenderer();
  try {
    for (const [locale, column] of [['en', 1], ['de', 2]]) {
      setLocale(locale);
      for (const row of BOUNDARIES) {
        assert.equal(formatSize(row[0]), row[column], `${locale}: ${row[0]}`);
      }
    }
  } finally {
    setLocale('en');
  }
});

test('main and renderer agree just below and above every unit', async () => {
  const { formatSize, setLocale } = await loadRenderer();
  try {
    for (const locale of ['en', 'de']) {
      setLocale(locale);
      for (const unit of [KB, MB, GB, TB]) {
        for (const bytes of [unit - 1, unit - 0.05 * (unit / 1024), unit, unit + 1]) {
          assert.equal(formatSize(bytes), formatBytes(bytes, locale), `${locale}: ${bytes}`);
        }
      }
    }
  } finally {
    setLocale('en');
  }
});
