'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRememberedUiPrefs } = require('../src/main/services/remembered-ui-prefs');
const { defaultOnSwitch } = require('../src/main/services/ui-pref-switches');

function setup(prefs, { delay = null } = {}) {
  const locales = [];
  const hidden = [];
  const remembered = createRememberedUiPrefs({
    uiPrefsStore: { readUIPrefs: () => (delay ? delay.then(() => prefs) : Promise.resolve(prefs)) },
    onAppLocaleChanged: (locale) => locales.push(locale),
    onShowHiddenFilesChanged: (show) => hidden.push(show),
  });
  return { remembered, locales, hidden };
}

test('before the preferences are read the language is the default and hidden files are off', () => {
  const { remembered } = setup({ appLocale: 'de', showHiddenFiles: true }, { delay: new Promise(() => {}) });
  assert.equal(remembered.getAppLocale(), 'en');
  assert.equal(remembered.getShowHiddenFiles(), false);
});

test('a stored language other than the default is taken over and reported once (#277)', async () => {
  const { remembered, locales } = setup({ appLocale: 'de' });
  await remembered.whenRead();
  assert.equal(remembered.getAppLocale(), 'de');
  assert.deepEqual(locales, ['de']);
});

test('the default language stored is no change', async () => {
  const { remembered, locales } = setup({ appLocale: 'en' });
  await remembered.whenRead();
  assert.deepEqual(locales, []);
});

test('a language set from the settings is normalised and reported', async () => {
  const { remembered, locales } = setup({});
  await remembered.whenRead();
  remembered.setAppLocale('xx');
  assert.equal(remembered.getAppLocale(), 'en');
  remembered.setAppLocale('de');
  assert.deepEqual(locales, ['en', 'de']);
});

test('hidden files stored as on tick the menu at start-up (#436)', async () => {
  const { remembered, hidden } = setup({ showHiddenFiles: true });
  await remembered.whenRead();
  assert.equal(remembered.getShowHiddenFiles(), true);
  assert.deepEqual(hidden, [true]);
});

test('a toggle that beats the start-up read wins', async () => {
  let release;
  const { remembered, hidden } = setup({ showHiddenFiles: true }, { delay: new Promise((resolve) => { release = resolve; }) });
  remembered.setShowHiddenFiles(false);
  release();
  await remembered.whenRead();
  assert.equal(remembered.getShowHiddenFiles(), false);
  assert.deepEqual(hidden, [false]);
});

test('unreadable preferences leave both at their defaults', async () => {
  const remembered = createRememberedUiPrefs({ uiPrefsStore: { readUIPrefs: () => Promise.reject(new Error('gone')) } });
  await remembered.whenRead();
  assert.equal(remembered.getAppLocale(), 'en');
  assert.equal(remembered.getShowHiddenFiles(), false);
});

test('a default-on switch is on until it is stored as off, and read afresh each time', async () => {
  const prefs = {};
  const isOn = defaultOnSwitch({ readUIPrefs: async () => prefs }, 'autoUpdateCheckEnabled');
  assert.equal(await isOn(), true);
  prefs.autoUpdateCheckEnabled = false;
  assert.equal(await isOn(), false);
  prefs.autoUpdateCheckEnabled = 'no';
  assert.equal(await isOn(), true);
});
