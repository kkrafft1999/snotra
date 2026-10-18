// The macOS and Linux update helpers, run for real (#1003).
//
// update-installer.test.js checks what the scripts are built from; this file
// runs them with /bin/sh — bash on macOS, dash on the Ubuntu runner — against
// stand-ins for the app. A stand-in is a shell script that notes that it ran
// and then does what the case needs: confirm its start the way the app does,
// end without confirming, or hang. On macOS `open` is replaced by a script on
// the PATH that runs the bundle's stand-in in the foreground, as `open -W`
// waits for the app.
//
// Every case checks the contract the issue asks for: a log, a status file the
// next start reads, the previous version back and started on failure, and the
// backup gone only once the new version has confirmed its start.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  buildMacRelaunchScript,
  buildLinuxAppImageScript,
  buildLinuxDirScript,
} = require('../src/main/services/update-installer');
const { createUpdateService } = require('../src/main/services/update-service');
const { removeTempDir } = require('./helpers/temp-dir');

const SKIP = process.platform === 'win32' ? 'the POSIX helpers need /bin/sh' : false;
const VERSION = '1.8.0';
const SERVICE = path.join(__dirname, '..', 'src', 'main', 'services', 'update-service.js');

/** A temp folder with a user data folder in it, as the app's helper files expect. */
function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-posix-helper-'));
  const userData = path.join(root, 'userData');
  const work = path.join(root, 'work');
  const shims = path.join(root, 'shims');
  for (const dir of [userData, work, shims]) fs.mkdirSync(dir, { recursive: true });
  const started = path.join(root, 'started.txt');
  const fixture = {
    root,
    userData,
    work,
    shims,
    started,
    // The names update-service.js gives them.
    files: {
      version: VERSION,
      logFile: path.join(userData, 'update-install.log'),
      statusFile: path.join(userData, 'update-install-failed.json'),
      pendingFile: path.join(userData, 'update-install-pending.json'),
    },
    pids: [],
  };
  t.after(async () => {
    for (const pid of readLines(started).map((line) => Number(line.split(' ')[1]))) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ }
    }
    for (const child of fixture.pids) {
      try { child.kill('SIGKILL'); } catch { /* gone already */ }
    }
    await removeTempDir(root);
  });
  return fixture;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * A stand-in for the app at `file`. It writes `<label> <pid>` to the fixture's
 * `started.txt`, then:
 * - `confirm` removes the pending record through update-service.js itself, as
 *   the app does once its window is open, and stays up for a moment;
 * - `crash` ends with exit code 3 without confirming;
 * - `hang` never confirms and does not end on its own;
 * - `exit` just ends — the previous version, started again after a rollback.
 */
function writeStandIn(fixture, file, label, behaviour) {
  const confirm = `${JSON.stringify(process.execPath)} -e ${shellQuote(
    `require(${JSON.stringify(SERVICE)}).createUpdateService({ app: { getVersion: () => ${JSON.stringify(VERSION)},`
    + ` getPath: () => ${JSON.stringify(fixture.userData)} } }).confirmInstallStarted()`
    + '.then((ok) => process.exit(ok ? 0 : 9))',
  )} || exit 9`;
  const body = {
    confirm: `${confirm}\nsleep 1`,
    crash: 'exit 3',
    // A loop rather than one long sleep: the shell keeps its command line,
    // which is what `pkill -f` looks for on macOS.
    hang: 'while :; do sleep 0.2; done',
    exit: 'exit 0',
  }[behaviour];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho "${label} $$" >> ${shellQuote(fixture.started)}\n${body}\n`, { mode: 0o755 });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * `open` as the helper calls it: the last argument is the bundle. Like the
 * real one it is a process of its own, not the app — ending it leaves the app
 * running, and only ends when the app does.
 */
function writeOpenShim(fixture) {
  fs.writeFileSync(path.join(fixture.shims, 'open'),
    '#!/bin/sh\nfor bundle; do :; done\n/bin/sh "$bundle/Contents/MacOS/app"\n', { mode: 0o755 });
}

/** A process that stands for the app that is quitting: it ends after `ms`. */
function quittingApp(fixture, ms) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });
  fixture.pids.push(child);
  return child.pid;
}

/** Runs the helper script to its end, as the detached child the app starts. */
async function runHelper(fixture, script) {
  const file = path.join(fixture.work, 'relaunch.sh');
  fs.writeFileSync(file, script, { mode: 0o700 });
  const child = spawn('/bin/sh', [file], {
    stdio: 'ignore',
    env: { ...process.env, PATH: `${fixture.shims}${path.delimiter}${process.env.PATH}` },
  });
  fixture.pids.push(child);
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const code = await new Promise((resolve) => child.once('exit', (c, signal) => resolve(signal || c)));
  clearTimeout(timer);
  return code;
}

function readStatus(fixture) {
  return JSON.parse(fs.readFileSync(fixture.files.statusFile, 'utf8'));
}

function startedLabels(fixture) {
  return readLines(fixture.started).map((line) => line.split(' ')[0]);
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What the next start of the app makes of the status file. */
async function nextStartReads(fixture, runningVersion = '1.7.1') {
  const svc = createUpdateService({
    app: { getVersion: () => runningVersion, getPath: () => fixture.userData },
    storage: { readUIPrefs: async () => ({}), updateUIPrefs: async () => {} },
  });
  return svc.readInstallFailure();
}

// --- Linux folder ----------------------------------------------------------

function linuxDirCase(t, { newBehaviour, backupDir, quitMs = 300, ...overrides } = {}) {
  const fixture = makeFixture(t);
  const apps = path.join(fixture.root, 'apps');
  const installDir = path.join(apps, 'snotra-ai');
  const stagedDir = path.join(apps, '.snotra-new-1');
  writeStandIn(fixture, path.join(installDir, 'Snotra AI'), 'old', 'exit');
  fs.writeFileSync(path.join(installDir, 'version.txt'), 'old');
  writeStandIn(fixture, path.join(stagedDir, 'Snotra Agent'), 'new', newBehaviour);
  fs.writeFileSync(path.join(stagedDir, 'version.txt'), 'new');
  const script = buildLinuxDirScript({
    pid: quittingApp(fixture, quitMs),
    installDir,
    stagedDir,
    backupDir: backupDir || path.join(apps, '.snotra-old-1'),
    workDir: fixture.work,
    binaryName: 'Snotra Agent',
    previousBinaryName: 'Snotra AI',
    ...fixture.files,
    quitSeconds: 10,
    startSeconds: 10,
    ...overrides,
  });
  return { fixture, apps, installDir, stagedDir, script };
}

test('Linux folder: a new version that confirms its start replaces the old one, and the backup goes', { skip: SKIP }, async (t) => {
  const { fixture, apps, installDir, script } = linuxDirCase(t, { newBehaviour: 'confirm' });
  // A failure from an earlier attempt must not be reported after this one worked.
  fs.writeFileSync(fixture.files.statusFile, '{"version":"1.8.0","error":"old"}');

  assert.equal(await runHelper(fixture, script), 0);

  assert.equal(fs.readFileSync(path.join(installDir, 'version.txt'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(apps), ['snotra-ai'], 'neither backup nor staging folder is left');
  assert.deepEqual(startedLabels(fixture), ['new']);
  assert.equal(fs.existsSync(fixture.files.pendingFile), false);
  assert.equal(fs.existsSync(fixture.files.statusFile), false);
  assert.equal(fs.existsSync(fixture.work), false);
  const log = fs.readFileSync(fixture.files.logFile, 'utf8');
  assert.match(log, /update to 1\.8\.0: waiting for process \d+/);
  assert.match(log, /starting the new version/);
  assert.match(log, /updated to 1\.8\.0\n$/);
});

test('Linux folder: a new version that ends before confirming is rolled back and the old one starts', { skip: SKIP }, async (t) => {
  const { fixture, apps, installDir, script } = linuxDirCase(t, { newBehaviour: 'crash' });

  assert.equal(await runHelper(fixture, script), 0, 'the helper ends as the old version it started');

  assert.equal(fs.readFileSync(path.join(installDir, 'version.txt'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(apps), ['snotra-ai']);
  assert.deepEqual(startedLabels(fixture), ['new', 'old']);
  assert.equal(fs.existsSync(fixture.files.pendingFile), false);
  const status = readStatus(fixture);
  assert.equal(status.version, '1.8.0');
  assert.equal(status.stage, 'start');
  assert.match(status.error, /^the new version ended before it had started \(exit code \d+\)$/);
  assert.equal(status.log, fixture.files.logFile);
  assert.match(status.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(fs.readFileSync(fixture.files.logFile, 'utf8'), /starting the previous version again/);

  assert.deepEqual(await nextStartReads(fixture), {
    version: '1.8.0', stage: 'start', error: status.error, logFile: fixture.files.logFile,
  });
});

test('Linux folder: a new version that hangs is stopped after the time-out and rolled back', { skip: SKIP }, async (t) => {
  const { fixture, installDir, script } = linuxDirCase(t, { newBehaviour: 'hang', startSeconds: 1 });

  await runHelper(fixture, script);

  const newPid = Number(readLines(fixture.started)[0].split(' ')[1]);
  assert.equal(isRunning(newPid), false, 'the version that did not start is ended');
  assert.equal(fs.readFileSync(path.join(installDir, 'version.txt'), 'utf8'), 'old');
  assert.deepEqual(startedLabels(fixture), ['new', 'old']);
  assert.equal(readStatus(fixture).error, 'the new version did not start within 1 seconds');
});

test('Linux folder: a move that fails leaves the old version in place and starts it', { skip: SKIP }, async (t) => {
  const { fixture, apps, installDir, script } = linuxDirCase(t, {
    newBehaviour: 'confirm',
    // A folder that does not exist: the first move fails.
    backupDir: path.join(os.tmpdir(), 'snotra-no-such-folder', `.snotra-old-${process.pid}`),
  });

  await runHelper(fixture, script);

  assert.equal(fs.readFileSync(path.join(installDir, 'version.txt'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(apps), ['snotra-ai'], 'the staged version is removed');
  assert.deepEqual(startedLabels(fixture), ['old']);
  const status = readStatus(fixture);
  assert.equal(status.stage, 'swap');
  assert.match(status.error, /^mv: /, "mv's own words are the reason");
  assert.equal((await nextStartReads(fixture)).stage, 'swap');
});

test('Linux folder: an app that does not quit is left alone and the failure recorded', { skip: SKIP }, async (t) => {
  const { fixture, apps, installDir, script } = linuxDirCase(t, {
    newBehaviour: 'confirm', quitMs: 20_000, quitSeconds: 0.6,
  });

  assert.equal(await runHelper(fixture, script), 1);

  assert.equal(fs.readFileSync(path.join(installDir, 'version.txt'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(apps), ['snotra-ai']);
  assert.deepEqual(startedLabels(fixture), [], 'nothing is started next to the app that still runs');
  assert.deepEqual(readStatus(fixture).error, 'the app did not quit within 0.6 seconds');
});

// --- AppImage --------------------------------------------------------------

function appImageCase(t, { newBehaviour, backupPath, ...overrides } = {}) {
  const fixture = makeFixture(t);
  const apps = path.join(fixture.root, 'apps');
  const appImagePath = path.join(apps, 'Snotra.AppImage');
  const stagedPath = `${appImagePath}.new-1`;
  writeStandIn(fixture, appImagePath, 'old', 'exit');
  writeStandIn(fixture, stagedPath, 'new', newBehaviour);
  const script = buildLinuxAppImageScript({
    pid: quittingApp(fixture, 300),
    appImagePath,
    stagedPath,
    backupPath: backupPath || `${appImagePath}.old-1`,
    workDir: fixture.work,
    ...fixture.files,
    quitSeconds: 10,
    startSeconds: 10,
    ...overrides,
  });
  return { fixture, apps, appImagePath, script };
}

function standInLabel(file) {
  return fs.readFileSync(file, 'utf8').match(/echo "(\w+) /)[1];
}

test('AppImage: a new file that confirms its start replaces the old one, and the backup goes', { skip: SKIP }, async (t) => {
  const { fixture, apps, appImagePath, script } = appImageCase(t, { newBehaviour: 'confirm' });

  assert.equal(await runHelper(fixture, script), 0);

  assert.equal(standInLabel(appImagePath), 'new');
  assert.equal(fs.statSync(appImagePath).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(apps), ['Snotra.AppImage']);
  assert.deepEqual(startedLabels(fixture), ['new']);
  assert.match(fs.readFileSync(fixture.files.logFile, 'utf8'), /updated to 1\.8\.0\n$/);
});

test('AppImage: a new file that ends before confirming is replaced by the old one again', { skip: SKIP }, async (t) => {
  const { fixture, apps, appImagePath, script } = appImageCase(t, { newBehaviour: 'crash' });

  await runHelper(fixture, script);

  assert.equal(standInLabel(appImagePath), 'old');
  assert.deepEqual(fs.readdirSync(apps), ['Snotra.AppImage']);
  assert.deepEqual(startedLabels(fixture), ['new', 'old']);
  assert.equal(readStatus(fixture).stage, 'start');
  assert.equal(fs.existsSync(fixture.files.pendingFile), false);
});

test('AppImage: a move that fails leaves the old file in place and starts it', { skip: SKIP }, async (t) => {
  const { fixture, apps, appImagePath, script } = appImageCase(t, {
    newBehaviour: 'confirm',
    backupPath: path.join(os.tmpdir(), 'snotra-no-such-folder', `Snotra.AppImage.old-${process.pid}`),
  });

  await runHelper(fixture, script);

  assert.equal(standInLabel(appImagePath), 'old');
  assert.deepEqual(fs.readdirSync(apps), ['Snotra.AppImage'], 'the staged file is removed');
  assert.deepEqual(startedLabels(fixture), ['old']);
  assert.equal(readStatus(fixture).stage, 'swap');
});

// --- macOS -----------------------------------------------------------------

// The app has already renamed the bundles when the helper runs (installMacos):
// the old one waits as the backup, the new one stands at `target`.
function macCase(t, { newBehaviour, renamed = false, quitMs = 300, ...overrides } = {}) {
  const fixture = makeFixture(t);
  writeOpenShim(fixture);
  const apps = path.join(fixture.root, 'Applications');
  const appBundlePath = path.join(apps, 'Snotra AI.app');
  const targetBundlePath = renamed ? path.join(apps, 'Snotra Agent.app') : appBundlePath;
  const backupPath = path.join(apps, '.snotra-old-1.app');
  writeStandIn(fixture, path.join(backupPath, 'Contents', 'MacOS', 'app'), 'old', 'exit');
  writeStandIn(fixture, path.join(targetBundlePath, 'Contents', 'MacOS', 'app'), 'new', newBehaviour);
  const script = buildMacRelaunchScript({
    pid: quittingApp(fixture, quitMs),
    appBundlePath,
    targetBundlePath,
    backupPath,
    workDir: fixture.work,
    ...fixture.files,
    quitSeconds: 10,
    startSeconds: 10,
    ...overrides,
  });
  return { fixture, apps, appBundlePath, targetBundlePath, script };
}

const macApp = (bundle) => path.join(bundle, 'Contents', 'MacOS', 'app');

test('macOS: a bundle that confirms its start stays, and the backup goes', { skip: SKIP }, async (t) => {
  const { fixture, apps, targetBundlePath, script } = macCase(t, { newBehaviour: 'confirm', renamed: true });

  assert.equal(await runHelper(fixture, script), 0);

  assert.equal(standInLabel(macApp(targetBundlePath)), 'new');
  assert.deepEqual(fs.readdirSync(apps), ['Snotra Agent.app']);
  assert.deepEqual(startedLabels(fixture), ['new']);
  assert.equal(fs.existsSync(fixture.files.pendingFile), false);
  assert.equal(fs.existsSync(fixture.work), false);
  assert.match(fs.readFileSync(fixture.files.logFile, 'utf8'), /updated to 1\.8\.0\n$/);
});

test('macOS: a bundle that ends before confirming goes, and the old one is back under its name', { skip: SKIP }, async (t) => {
  const { fixture, apps, appBundlePath, script } = macCase(t, { newBehaviour: 'crash', renamed: true });

  assert.equal(await runHelper(fixture, script), 1);

  assert.deepEqual(fs.readdirSync(apps), ['Snotra AI.app'], 'the renamed new bundle is gone (#794)');
  assert.equal(standInLabel(macApp(appBundlePath)), 'old');
  assert.deepEqual(startedLabels(fixture), ['new', 'old']);
  const status = readStatus(fixture);
  assert.equal(status.stage, 'start');
  assert.match(status.error, /^the new version ended before it had started/);
  assert.equal((await nextStartReads(fixture)).stage, 'start');
});

test('macOS: a bundle that hangs is ended by its path and replaced by the old one', { skip: SKIP }, async (t) => {
  const { fixture, apps, appBundlePath, script } = macCase(t, { newBehaviour: 'hang', startSeconds: 1 });

  await runHelper(fixture, script);

  const newPid = Number(readLines(fixture.started)[0].split(' ')[1]);
  assert.equal(isRunning(newPid), false, 'pkill found the new version by its bundle path');
  assert.deepEqual(fs.readdirSync(apps), ['Snotra AI.app']);
  assert.equal(standInLabel(macApp(appBundlePath)), 'old');
  assert.deepEqual(startedLabels(fixture), ['new', 'old']);
  assert.equal(readStatus(fixture).error, 'the new version did not start within 1 seconds');
});

test('macOS: an app that does not quit gets its bundle back, and nothing is opened', { skip: SKIP }, async (t) => {
  const { fixture, apps, appBundlePath, script } = macCase(t, {
    newBehaviour: 'confirm', renamed: true, quitMs: 20_000, quitSeconds: 0.6,
  });

  assert.equal(await runHelper(fixture, script), 1);

  assert.deepEqual(fs.readdirSync(apps), ['Snotra AI.app']);
  assert.equal(standInLabel(macApp(appBundlePath)), 'old');
  assert.deepEqual(startedLabels(fixture), []);
  const status = readStatus(fixture);
  assert.equal(status.stage, 'swap');
  assert.equal(status.error, 'the app did not quit within 0.6 seconds');
});

test('the status file stays valid JSON whatever the reason says', { skip: SKIP }, async (t) => {
  const { fixture, script } = linuxDirCase(t, {
    newBehaviour: 'confirm',
    backupDir: path.join(os.tmpdir(), 'snotra-no-such-folder', 'a "quoted" \\ back\tslash'),
  });

  await runHelper(fixture, script);

  // readStatus parsed it. How mv words the name differs — GNU quotes it the
  // shell's way — so only the characters JSON has to escape are looked for.
  const status = readStatus(fixture);
  assert.equal(status.stage, 'swap');
  assert.match(status.error, /a "quoted" \\ back/);
  assert.doesNotMatch(status.error, /\t/, 'a tab becomes a space');
});
