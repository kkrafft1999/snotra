const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, smokeStart, PENDING_FILE, DEFAULT_TIMEOUT_SECONDS } = require('../scripts/smoke-start');

// #1066: the release pipeline starts every packaged artifact once and waits
// for the signal the update helper waits for. These tests stand a small Node
// process in for the app, so the waiting, the time-out and the clean-up run
// against a real child process on every platform CI covers.

/** A stand-in app: `body` runs with `dir` set to its user data folder. */
function fakeApp(body) {
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const arg = process.argv.find((a) => a.startsWith('--user-data-dir='));",
    "const dir = arg.slice('--user-data-dir='.length);",
    body,
  ].join('\n');
  // '--' ends Node's own options, so --user-data-dir reaches the script.
  return { command: process.execPath, args: ['-e', script, '--'] };
}

/** Removes the pending record the way the app does, then keeps running. */
const CONFIRMS = `
  if (process.env.SNOTRA_NO_UPDATE_CHECK !== '1') process.exit(3);
  const record = JSON.parse(fs.readFileSync(path.join(dir, '${PENDING_FILE}'), 'utf8'));
  if (record.version !== '9.8.7') process.exit(4);
  setTimeout(() => fs.rmSync(path.join(dir, '${PENDING_FILE}')), 100);
  setInterval(() => {}, 1000);
`;

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-start-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a start counts once the app removed the pending record, and the app is ended again', async (t) => {
  const tmpDir = tmpRoot(t);
  const app = fakeApp(`${CONFIRMS}\nfs.writeFileSync(path.join(dir, '..', 'pid'), String(process.pid));`);
  const result = await smokeStart({ ...app, version: '9.8.7', timeoutMs: 20_000, pollMs: 25, tmpDir });

  assert.equal(result.reason, '');
  assert.equal(result.ok, true);
  const pid = Number(fs.readFileSync(path.join(tmpDir, 'pid'), 'utf8'));
  assert.equal(isAlive(pid), false, 'the started app is still running');
  assert.deepEqual(fs.readdirSync(tmpDir).filter((name) => name.startsWith('snotra-smoke-')), [],
    'the user data folder is left behind');
});

test('an app that ends before it confirmed fails, with its exit code and its log', async (t) => {
  const tmpDir = tmpRoot(t);
  const app = fakeApp(`
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.writeFileSync(path.join(dir, 'logs', 'main.log'), 'Cannot find module better-sqlite3\\n');
    console.error('boom on stderr');
    process.exit(7);
  `);
  const result = await smokeStart({ ...app, version: '9.8.7', timeoutMs: 20_000, pollMs: 25, tmpDir });

  assert.equal(result.ok, false);
  assert.match(result.reason, /ended before its window was open \(exit code 7\)/);
  assert.match(result.output, /boom on stderr/);
  assert.match(result.appLog, /main\.log[\s\S]*Cannot find module better-sqlite3/);
});

test('an app that neither confirms nor ends fails at the time-out and is ended', async (t) => {
  const tmpDir = tmpRoot(t);
  const app = fakeApp(`
    fs.writeFileSync(path.join(dir, '..', 'pid'), String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const result = await smokeStart({ ...app, version: '9.8.7', timeoutMs: 1_500, pollMs: 25, tmpDir });

  assert.equal(result.ok, false);
  assert.match(result.reason, /did not confirm its start within 2 s/);
  const pid = Number(fs.readFileSync(path.join(tmpDir, 'pid'), 'utf8'));
  assert.equal(isAlive(pid), false, 'the hanging app is still running');
});

test('a command that cannot be started fails with the reason', async (t) => {
  const tmpDir = tmpRoot(t);
  const result = await smokeStart({
    command: path.join(tmpDir, 'no-such-app'),
    version: '9.8.7',
    timeoutMs: 5_000,
    pollMs: 25,
    tmpDir,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be started: .*ENOENT/);
});

test('parseArgs takes the executable and its arguments after --', () => {
  assert.deepEqual(parseArgs(['--', '/opt/Snotra Agent', '--flag']), {
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    label: 'Snotra Agent',
    command: '/opt/Snotra Agent',
    args: ['--flag'],
  });
  assert.deepEqual(parseArgs(['--timeout', '30', '--label', 'AppImage', '--', 'x.AppImage']), {
    timeoutSeconds: 30,
    label: 'AppImage',
    command: 'x.AppImage',
    args: [],
  });
  assert.throws(() => parseArgs(['/opt/app']), /Expected `-- <executable>/);
  assert.throws(() => parseArgs(['--']), /Expected `-- <executable>/);
  assert.throws(() => parseArgs(['--timeout', '0', '--', 'x']), /positive number/);
  assert.throws(() => parseArgs(['--verbose', '--', 'x']), /Unknown option "--verbose"/);
});
