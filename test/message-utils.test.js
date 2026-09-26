// Chat history timestamps follow the interface language, not the machine (#375).
//
// Dates are built in local time, and "now" is passed in, so the checks do not
// depend on the time zone or the day the tests run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer } = require('./helpers/dom.js');

const ENTRY = new Date(2026, 8, 21, 14, 32);
const SAME_DAY = new Date(2026, 8, 21, 18, 0);
const LATER = new Date(2026, 9, 1, 9, 0);

async function load(locale) {
  const { formatHistoryTime } = await importRenderer('chat', 'messageUtils.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale, { force: true });
  return formatHistoryTime;
}

test.after(async () => {
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
});

test('English: time for the same day, date for older entries', async () => {
  const format = await load('en');
  assert.match(format(ENTRY.getTime(), SAME_DAY), /^02:32\sPM$/);
  assert.match(format(ENTRY.getTime(), LATER), /^Sep 21, 2026$/);
});

test('German: time for the same day, date for older entries', async () => {
  const format = await load('de');
  assert.equal(format(ENTRY.getTime(), SAME_DAY), '14:32');
  assert.match(format(ENTRY.getTime(), LATER), /^21\. Sept?\.? 2026$/);
});

test('invalid input gives an empty string', async () => {
  const format = await load('en');
  assert.equal(format('not a date'), '');
  assert.equal(format(Number.NaN), '');
});
