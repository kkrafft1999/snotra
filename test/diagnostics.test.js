const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnosticsReport, hideHome } = require('../src/main/services/diagnostics-report');
const { createDiagnostics } = require('../src/main/electron/diagnostics');
const { registerDiagnosticsHandlers } = require('../src/main/ipc/diagnostics-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');

/** *Help › Copy diagnostics* and *Show log file* (#978). */

const LOG_LINES = [
  '2026-10-17T08:00:00.000Z INFO  Snotra Agent 1.24.0 started (darwin arm64)',
  '2026-10-17T08:01:00.000Z ERROR [main] Uncaught exception: Error: boom',
  '        at load (/Users/konrad/Projects/snotra/src/main/index.js:10:5)',
];

function fakeLogFile(lines = LOG_LINES) {
  return { filePath: '/Users/konrad/Library/Application Support/Snotra AI/logs/main.log', tail: (n) => lines.slice(-n) };
}

const BASE = Object.freeze({
  appName: 'Snotra Agent',
  appVersion: '1.24.0',
  platform: 'darwin',
  arch: 'arm64',
  osRelease: '25.0.0',
  versions: { electron: '39.0.0', chrome: '142.0', node: '24.1.0' },
  locale: 'de',
  errorCount: 1,
  homeDir: '/Users/konrad',
  now: () => new Date('2026-10-17T09:00:00.000Z'),
});

test('the report names version, system, runtime, language, error count and the log', () => {
  const report = buildDiagnosticsReport({ ...BASE, logFile: fakeLogFile() });
  const lines = report.split('\n');
  assert.equal(lines[0], 'Snotra Agent 1.24.0');
  assert.equal(lines[1], 'System: darwin 25.0.0 (arm64)');
  assert.equal(lines[2], 'Runtime: Electron 39.0.0 · Chromium 142.0 · Node 24.1.0');
  assert.equal(lines[3], 'Language: de');
  assert.equal(lines[4], 'Errors caught since start: 1');
  assert.ok(report.includes('--- The last 3 lines of the log ---'));
  assert.ok(report.includes('[main] Uncaught exception: Error: boom'));
});

test('the home folder is written as ~ — a pasted report does not name the account', () => {
  const report = buildDiagnosticsReport({ ...BASE, logFile: fakeLogFile() });
  assert.ok(!report.includes('/Users/konrad'));
  assert.ok(report.includes('Log file: ~/Library/Application Support/Snotra AI/logs/main.log'));
  assert.ok(report.includes('(~/Projects/snotra/src/main/index.js:10:5)'));
});

test('on Windows the home folder is hidden in both slash directions and any case', () => {
  const text = 'C:\\Users\\Konrad\\AppData\\x and c:/users/konrad/y';
  assert.equal(hideHome(text, 'C:\\Users\\Konrad'), '~\\AppData\\x and ~/y');
});

test('only the requested number of lines is taken, and an empty log says so', () => {
  const many = Array.from({ length: 300 }, (_, i) => `line ${i}`);
  const report = buildDiagnosticsReport({ ...BASE, logFile: fakeLogFile(many), tailLines: 200 });
  assert.ok(report.includes('--- The last 200 lines of the log ---'));
  assert.ok(!report.includes('line 99\n'));
  assert.ok(report.includes('line 299'));
  assert.ok(buildDiagnosticsReport({ ...BASE, logFile: fakeLogFile([]) }).includes('--- The log is empty ---'));
  assert.ok(buildDiagnosticsReport({ ...BASE, logFile: null }).includes('Log file: (none)'));
});

function makeDiagnostics({ clipboardThrows = false, response = 0 } = {}) {
  const calls = [];
  const diagnostics = createDiagnostics({
    app: { getVersion: () => '1.24.0' },
    os: { release: () => '25.0.0', homedir: () => '/Users/konrad' },
    processInfo: { platform: 'darwin', arch: 'arm64', versions: {} },
    logFile: fakeLogFile(),
    reporter: { count: () => 2 },
    clipboard: {
      writeText: (text) => {
        if (clipboardThrows) throw new Error('no clipboard');
        calls.push(['clipboard', text]);
      },
    },
    shell: { showItemInFolder: (file) => calls.push(['reveal', file]) },
    dialog: {
      showMessageBox: async (...args) => {
        calls.push(['dialog', args.at(-1)]);
        return { response };
      },
    },
    getMainWindow: () => null,
    getLocale: () => 'en',
    log: { error: (...args) => calls.push(['log', ...args]) },
  });
  return { diagnostics, calls };
}

test('copy puts the report on the clipboard', () => {
  const { diagnostics, calls } = makeDiagnostics();
  assert.equal(diagnostics.copy(), true);
  const [kind, text] = calls[0];
  assert.equal(kind, 'clipboard');
  assert.ok(text.startsWith('Snotra Agent 1.24.0\n'));
  assert.ok(text.includes('Errors caught since start: 2'));
});

test('a clipboard that fails is logged and reported as false', () => {
  const { diagnostics, calls } = makeDiagnostics({ clipboardThrows: true });
  assert.equal(diagnostics.copy(), false);
  assert.equal(calls[0][0], 'log');
});

test('from the menu a box confirms the copy and says what is in it', async () => {
  const { diagnostics, calls } = makeDiagnostics();
  assert.equal(await diagnostics.copyFromMenu(), true);
  const box = calls.find(([kind]) => kind === 'dialog')[1];
  assert.equal(box.type, 'info');
  assert.equal(box.message, 'Diagnostics copied');
  assert.match(box.detail, /last 200 lines of the log/);
  assert.deepEqual(box.buttons, ['OK', 'Show Log File']);
  assert.equal(calls.some(([kind]) => kind === 'reveal'), false);
});

test('the box\'s second button shows the log file; a failed copy says so in German too', async () => {
  const shown = makeDiagnostics({ response: 1 });
  await shown.diagnostics.copyFromMenu();
  assert.deepEqual(shown.calls.at(-1), ['reveal', fakeLogFile().filePath]);

  const failed = makeDiagnostics({ clipboardThrows: true });
  const de = createDiagnostics({
    app: { getVersion: () => '1' },
    os: { release: () => '', homedir: () => '' },
    processInfo: { platform: 'linux', arch: 'x64', versions: {} },
    logFile: fakeLogFile(),
    clipboard: { writeText() { throw new Error('x'); } },
    shell: { showItemInFolder() {} },
    dialog: { showMessageBox: async (options) => { failed.calls.push(['box', options]); return { response: 0 }; } },
    getLocale: () => 'de',
    log: { error() {} },
  });
  assert.equal(await de.copyFromMenu(), false);
  const box = failed.calls.find(([kind]) => kind === 'box')[1];
  assert.equal(box.type, 'error');
  assert.equal(box.message, 'Die Diagnose konnte nicht kopiert werden');
});

test('revealLog shows the log file, and says false without a shell', () => {
  const { diagnostics, calls } = makeDiagnostics();
  assert.equal(diagnostics.revealLog(), true);
  assert.deepEqual(calls[0], ['reveal', fakeLogFile().filePath]);
  const bare = createDiagnostics({ app: {}, os: {}, logFile: fakeLogFile(), clipboard: {}, shell: null });
  assert.equal(bare.revealLog(), false);
});

test('the IPC handlers hand window reports to the reporter and copy on request', async () => {
  const handlers = new Map();
  const reports = [];
  registerDiagnosticsHandlers({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    REQ,
    reporter: { reportRenderer: (payload) => { reports.push(payload); return payload !== null; } },
    diagnostics: { copy: () => true },
  });
  assert.deepEqual(await handlers.get(REQ.DIAGNOSTICS_REPORT_ERROR)({}, { message: 'x' }), { ok: true });
  assert.deepEqual(await handlers.get(REQ.DIAGNOSTICS_REPORT_ERROR)({}, null), { ok: false });
  assert.deepEqual(await handlers.get(REQ.DIAGNOSTICS_COPY)({}), { ok: true });
  assert.deepEqual(reports, [{ message: 'x' }, null]);
});
