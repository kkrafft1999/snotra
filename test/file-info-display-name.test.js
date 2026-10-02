// "Opens with" shows the name Finder shows (#650).
//
// The JXA one-liner returned the bundle's file name, so a German Mac read
// "Preview" where Finder says "Vorschau". It now asks NSFileManager for the
// display name; a trailing ".app" is stripped, and every failure still ends
// as "unknown".

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultAppResolver, createFileInfo } = require('../src/main/services/file-info');
const { translate } = require('../src/shared/i18n');

/** An `execFile` that answers every call with `stdout`, or with `error`. */
function runner({ stdout = '', error = null } = {}) {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args });
    callback(error, stdout);
  };
  return { execFile, calls };
}

test('the macOS script asks for the display name, not the bundle file name', async () => {
  const { execFile, calls } = runner({ stdout: 'Vorschau.app\n' });
  await createDefaultAppResolver({ platform: 'darwin', execFile }).resolve('/ws/a.pdf');
  const script = calls[0].args[3];
  assert.match(script, /URLForApplicationToOpenURL/);
  assert.match(script, /NSFileManager\.defaultManager\.displayNameAtPath\(u\.path\)/);
  assert.doesNotMatch(script, /lastPathComponent/);
});

test('the display name is shown with and without a trailing .app', async () => {
  for (const [stdout, expected] of [
    ['Vorschau.app\n', 'Vorschau'],
    ['Vorschau\n', 'Vorschau'],
    ['Visual Studio Code.APP\r\n', 'Visual Studio Code'],
    // Only the extension goes, not an ".app" inside the name.
    ['My.app Tool\n', 'My.app Tool'],
  ]) {
    const { execFile } = runner({ stdout });
    assert.equal(await createDefaultAppResolver({ platform: 'darwin', execFile }).resolve('/ws/a.pdf'), expected, stdout);
  }
});

test('no app, a failing script or a bare ".app" end as null', async () => {
  for (const options of [{ stdout: '' }, { stdout: '\n' }, { stdout: '.app\n' }, { error: new Error('osascript failed') }]) {
    const { execFile } = runner(options);
    assert.equal(await createDefaultAppResolver({ platform: 'darwin', execFile }).resolve('/ws/a.pdf'), null);
  }
});

test('a script that never answers ends as null after the timeout', async () => {
  const execFile = () => {};
  const resolver = createDefaultAppResolver({ platform: 'darwin', execFile, timeoutMs: 5 });
  assert.equal(await resolver.resolve('/ws/a.pdf'), null);
});

test('the info dialog shows the display name, or "unknown"', async () => {
  const stats = {
    size: 2048,
    mtime: new Date(2026, 9, 2, 9, 30),
    birthtime: new Date(2026, 9, 1, 8, 0),
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  const fs = { lstat: async () => stats };
  const openWith = (fields) => fields.find(([label]) => label === translate('de', 'fileInfo.field.openWith'))[1];

  const found = runner({ stdout: 'Vorschau.app\n' });
  const info = createFileInfo({ fs, platform: 'darwin', execFile: found.execFile });
  assert.equal(openWith((await info.describe('/ws/a.pdf', { locale: 'de' })).fields), 'Vorschau');

  const missing = runner({ stdout: '' });
  const none = createFileInfo({ fs, platform: 'darwin', execFile: missing.execFile });
  assert.equal(openWith((await none.describe('/ws/a.pdf', { locale: 'de' })).fields), translate('de', 'fileInfo.unknown'));
});
