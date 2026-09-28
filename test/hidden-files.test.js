// Hidden files in the folder panel (#436): which names are listed, and the
// shortcut that switches them. The tree's own behaviour is covered in
// test/file-tree-dom.test.js, the listing through IPC in test/fs-handlers.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isHiddenEntryName,
  isAlwaysHiddenEntryName,
  isListedEntryName,
} = require('../src/shared/runtime/hidden-entries');
const {
  matchesHiddenFilesShortcut,
  createHiddenFilesShortcutHandler,
} = require('../src/main/services/hidden-files-shortcut');

test('a hidden entry is one whose name starts with a dot', () => {
  assert.equal(isHiddenEntryName('.env'), true);
  assert.equal(isHiddenEntryName('.github'), true);
  assert.equal(isHiddenEntryName('README.md'), false);
  assert.equal(isHiddenEntryName('v1.2'), false);
  assert.equal(isHiddenEntryName(undefined), false);
});

test('system noise stays out, whatever the case (#436)', () => {
  for (const name of ['.git', '.DS_Store', 'Thumbs.db', 'desktop.ini', 'THUMBS.DB', 'Desktop.ini', '.ds_store']) {
    assert.equal(isAlwaysHiddenEntryName(name), true, name);
    assert.equal(isListedEntryName(name, { showHidden: true }), false, `${name} with hidden files shown`);
    assert.equal(isListedEntryName(name), false, `${name} with hidden files off`);
  }
  // Close relatives are ordinary entries.
  for (const name of ['.gitignore', '.github', '.gitattributes', 'git']) {
    assert.equal(isAlwaysHiddenEntryName(name), false, name);
  }
});

test('dot entries are listed only with showHidden (#436)', () => {
  assert.equal(isListedEntryName('.env'), false);
  assert.equal(isListedEntryName('.env', { showHidden: true }), true);
  assert.equal(isListedEntryName('README.md'), true);
  assert.equal(isListedEntryName('README.md', { showHidden: true }), true);
  // Only a real `true` switches them on.
  assert.equal(isListedEntryName('.env', { showHidden: 'yes' }), false);
});

const key = (overrides) => ({
  type: 'keyDown',
  code: 'Period',
  key: '.',
  shift: true,
  control: false,
  alt: false,
  meta: false,
  isAutoRepeat: false,
  ...overrides,
});

test('macOS: Cmd+Shift+. — the Finder shortcut (#436)', () => {
  assert.equal(matchesHiddenFilesShortcut(key({ meta: true }), 'darwin'), true);
  assert.equal(matchesHiddenFilesShortcut(key({ control: true }), 'darwin'), false);
  assert.equal(matchesHiddenFilesShortcut(key({ meta: true, control: true }), 'darwin'), false);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform}: Ctrl+Shift+. (#436)`, () => {
    assert.equal(matchesHiddenFilesShortcut(key({ control: true }), platform), true);
    assert.equal(matchesHiddenFilesShortcut(key({ meta: true }), platform), false);
    // AltGr on Windows arrives as Ctrl+Alt; that is another key entirely.
    assert.equal(matchesHiddenFilesShortcut(key({ control: true, alt: true }), platform), false);
  });
}

for (const platform of ['darwin', 'win32', 'linux']) {
  const mod = platform === 'darwin' ? { meta: true } : { control: true };

  test(`${platform}: a German keyboard types a colon, the key is still the period (#436)`, () => {
    assert.equal(matchesHiddenFilesShortcut(key({ ...mod, key: ':' }), platform), true);
  });

  test(`${platform}: without Shift, on another key or on key-up it is not the shortcut (#436)`, () => {
    assert.equal(matchesHiddenFilesShortcut(key({ ...mod, shift: false }), platform), false);
    assert.equal(matchesHiddenFilesShortcut(key({ ...mod, code: 'Comma', key: ';' }), platform), false);
    assert.equal(matchesHiddenFilesShortcut(key({ ...mod, type: 'keyUp' }), platform), false);
    assert.equal(matchesHiddenFilesShortcut(null, platform), false);
  });
}

function runHandler(input, platform = 'darwin') {
  let toggles = 0;
  let prevented = 0;
  const handler = createHiddenFilesShortcutHandler({ platform, onToggle: () => { toggles += 1; } });
  handler({ preventDefault: () => { prevented += 1; } }, input);
  return { toggles, prevented };
}

test('the handler toggles once and keeps the key from page and menu (#436)', () => {
  assert.deepEqual(runHandler(key({ meta: true })), { toggles: 1, prevented: 1 });
});

test('a held key does not flicker the switch, but stays swallowed (#436)', () => {
  assert.deepEqual(runHandler(key({ meta: true, isAutoRepeat: true })), { toggles: 0, prevented: 1 });
});

test('any other key passes through untouched (#436)', () => {
  assert.deepEqual(runHandler(key({ meta: true, code: 'KeyB', key: 'b', shift: false })), { toggles: 0, prevented: 0 });
});
