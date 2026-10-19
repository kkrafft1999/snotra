'use strict';

// Services, tools and adapters run without Electron (#983, AR-08).
//
// What talks to Electron lives in src/main/electron/ (the desktop's adapters:
// the keychain, notifications, the window push, native dialogs, menus, the
// HTML preview) and in the shell around it — index.js, window.js, the IPC
// handlers. Everything under services/, tools/ and adapters/ gets ports and
// plain values instead: a secret store, not `safeStorage`; a user-data path,
// not `app.getPath`; an event push, not `webContents.send`. So a second host
// — a CLI, a headless server — can build them without Electron.
//
// The guard reads each file without comments and strings and fails on the
// names below. When it fails: hand the module a port or a value, or — when it
// is the desktop's by nature — move it to src/main/electron/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { codeOnly } = require('./helpers/code-only');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const GUARDED = ['services', 'tools', 'adapters'];

/** Electron's modules and the members of `app`, `shell` and `session` the app used to reach for. */
const ELECTRON_NAMES = [
  /\b(safeStorage|webContents|BrowserWindow|WebContentsView|ipcMain|ipcRenderer|Notification|nativeImage|nativeTheme|clipboard|dialog|Menu|MenuItem|Tray|powerMonitor|systemPreferences|globalShortcut|getMainWindow)\b/g,
  /\bapp\.(getPath|getVersion|getLocale|getAppPath|getName|quit|exit|relaunch|isPackaged|whenReady|on)\b/g,
  /\bshell\.(openExternal|openPath|showItemInFolder|trashItem|beep)\b/g,
  /\bsession\.(fromPartition|defaultSession)\b/g,
];

/** In the raw source, comments included: a require of Electron, or a type taken from it. */
const ELECTRON_MODULE = /\brequire\(\s*['"]electron['"]\s*\)|\bimport\(\s*['"]electron['"]\s*\)|\bElectron\.[A-Z]/g;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/** Each Electron name in `source`, with its line. */
function electronNames(source) {
  const code = codeOnly(source);
  const lineOf = (text, index) => text.slice(0, index).split('\n').length;
  const found = [];
  for (const pattern of ELECTRON_NAMES) {
    for (const match of code.matchAll(pattern)) found.push({ line: lineOf(code, match.index), name: match[0] });
  }
  for (const match of source.matchAll(ELECTRON_MODULE)) found.push({ line: lineOf(source, match.index), name: match[0] });
  return found.sort((a, b) => a.line - b.line);
}

test('services, tools and adapters name no Electron API', () => {
  const files = GUARDED.flatMap((dir) => jsFiles(path.join(MAIN, dir)));
  assert.ok(files.length > 100, `found only ${files.length} files — did the folders move?`);
  const findings = files.flatMap((file) => electronNames(fs.readFileSync(file, 'utf8'))
    .map(({ line, name }) => `${path.relative(MAIN, file)}:${line} ${name}`));
  assert.deepEqual(findings, [], 'hand the module a port or a value, or move it to src/main/electron/');
});

test('the guard catches what it is there for', () => {
  const samples = [
    "const { safeStorage } = require('electron');",
    'function f({ app }) { return app.getPath(\'userData\'); }',
    'win.webContents.send(channel, payload);',
    'const n = new Notification({ title });',
    'await dialog.showMessageBox(options);',
    'shell.trashItem(target);',
    '/** @param {import(\'electron\').BrowserWindow} win */ function f(win) {}',
    '/** @param {Electron.WebContents} target */ function f(target) {}',
  ];
  for (const sample of samples) assert.notDeepEqual(electronNames(sample), [], sample);
});

test('the guard leaves alone what only looks like Electron', () => {
  const samples = [
    '// the native dialog asks first; safeStorage keeps the key',
    "const label = 'Open in a new BrowserWindow';",
    'const { session } = loadChat(); session.messages.push(message);',
    'const shellPath = await shell.detect();',
    'safeStorageKey.whenDurable();',
  ];
  for (const sample of samples) assert.deepEqual(electronNames(sample), [], sample);
});

test('src/main/electron/ is where the desktop adapters are', () => {
  for (const name of ['safe-storage-backend.js', 'system-notification-adapter.js', 'window-push.js', 'native-confirmation-adapter.js']) {
    assert.ok(fs.existsSync(path.join(MAIN, 'electron', name)), name);
  }
});
