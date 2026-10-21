'use strict';

// Developer mode (#1213): kept in the UI preferences, switched only by its
// own toggle, caught as ⌘⌥⇧D / Ctrl+Alt+Shift+D by the physical key, and
// it opens pairing a phone while it is on.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeveloperMode } = require('../src/main/services/developer-mode');
const { matchesDeveloperModeShortcut, createDeveloperModeShortcutHandler } = require('../src/main/services/developer-mode-shortcut');
const { createAppNotices, developerModeNotices } = require('../src/main/services/app-notices');
const { normalizeUiPrefs, normalizeUiPrefsPatch } = require('../src/shared/contracts/settings');
const { NOTICE_KINDS, normalizeNotice } = require('../src/shared/contracts/notices');

function memoryPrefs(initial = {}) {
  let prefs = normalizeUiPrefs(initial);
  return {
    store: {
      readUIPrefs: async () => ({ ...prefs }),
      updateUIPrefs: async (updater) => { prefs = normalizeUiPrefs(await updater({ ...prefs })); return prefs; },
    },
    current: () => prefs,
  };
}

test('off by default; switched on and off, and kept in the preferences', async () => {
  const prefs = memoryPrefs();
  const mode = createDeveloperMode({ uiPrefsStore: prefs.store, log: { warn() {} } });
  const heard = [];
  mode.subscribe((on, how) => heard.push([on, how]));
  assert.equal(await mode.load(), false);
  assert.equal(await mode.toggle(), true);
  assert.equal(prefs.current().developerMode, true);
  const again = createDeveloperMode({ uiPrefsStore: prefs.store, log: { warn() {} } });
  assert.equal(await again.load(), true, 'it survives a restart');
  assert.equal(await mode.toggle(), false);
  assert.deepEqual(heard, [[true, 'switched'], [false, 'switched']], 'a stored "off" is no news');
  const heardAgain = [];
  again.subscribe((on, how) => heardAgain.push([on, how]));
  await again.load();
  assert.deepEqual(heardAgain, [], 'off again: still no news');
});

test('a preference that cannot be read counts as off', async () => {
  const warnings = [];
  const mode = createDeveloperMode({ uiPrefsStore: { readUIPrefs: async () => { throw new Error('EACCES'); } }, log: { warn: (m) => warnings.push(m) } });
  assert.equal(await mode.load(), false);
  assert.equal(warnings.length, 1);
});

test('only main\'s toggle writes it: the settings\' patch does not carry it', () => {
  assert.equal('developerMode' in normalizeUiPrefsPatch({ developerMode: true }), false);
  assert.equal(normalizeUiPrefs({ developerMode: 'yes' }).developerMode, false);
  assert.equal(normalizeUiPrefs({ developerMode: true }).developerMode, true);
});

test('the shortcut is Cmd+Option+Shift+D on macOS and Ctrl+Alt+Shift+D elsewhere, by the physical key', () => {
  const key = (extra) => ({ type: 'keyDown', code: 'KeyD', shift: true, alt: true, ...extra });
  assert.equal(matchesDeveloperModeShortcut(key({ meta: true }), 'darwin'), true);
  assert.equal(matchesDeveloperModeShortcut(key({ control: true }), 'win32'), true);
  assert.equal(matchesDeveloperModeShortcut(key({ control: true }), 'linux'), true);
  assert.equal(matchesDeveloperModeShortcut(key({ control: true }), 'darwin'), false);
  assert.equal(matchesDeveloperModeShortcut(key({ meta: true, alt: false }), 'darwin'), false, 'Cmd+Shift+D is something else');
  assert.equal(matchesDeveloperModeShortcut(key({ meta: true, code: 'KeyE' }), 'darwin'), false);
  assert.equal(matchesDeveloperModeShortcut({ ...key({ meta: true }), type: 'keyUp' }, 'darwin'), false);

  let toggled = 0;
  let prevented = 0;
  const handler = createDeveloperModeShortcutHandler({ platform: 'darwin', onToggle: () => { toggled += 1; } });
  handler({ preventDefault: () => { prevented += 1; } }, key({ meta: true }));
  handler({ preventDefault: () => { prevented += 1; } }, key({ meta: true, isAutoRepeat: true }));
  handler({ preventDefault: () => { prevented += 1; } }, key({ meta: true, code: 'KeyX' }));
  assert.equal(toggled, 1, 'once per press, not per repeat');
  assert.equal(prevented, 2);
});

test('switching says so in a notice; reading it at start does not', () => {
  const notices = createAppNotices({ log: { warn() {} } });
  const listener = developerModeNotices(notices);
  listener(true, 'loaded');
  assert.deepEqual(notices.list(), []);
  listener(true, 'switched');
  listener(false, 'switched');
  assert.deepEqual(notices.list(), [{ id: 'developer-mode', kind: NOTICE_KINDS.DEVELOPER_MODE, on: false, location: null, canReveal: false }]);
  assert.equal(normalizeNotice({ id: 'x', kind: NOTICE_KINDS.DEVELOPER_MODE }), null);
});
