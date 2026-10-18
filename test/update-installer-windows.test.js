// The Windows folder swap, run for real (#442).
//
// Everything else about the installer is checked as text; this file runs the
// actual PowerShell helper on the Windows CI runner. It rebuilds the case that
// broke in the field: the app was started from its own folder, so that folder
// is a process's working directory, which Windows will not let anyone rename.
//
// A small console program, compiled once per run, stands in for the app's
// .exe (#1067). A `stand-in.txt` next to it says what it does: confirm its
// start through update-service.js the way the app does once its window is
// open, end with exit code 3 without confirming, hang, or just end — the
// previous version, started again after a rollback. Each copy notes its label
// (the `version` file in its folder) and PID in `started.txt`.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const {
  createUpdateInstaller,
  buildWindowsSwapScript,
  buildWindowsLaunchCommand,
  helperOutputFile,
} = require('../src/main/services/update-installer');
const { createUpdateService } = require('../src/main/services/update-service');
const { writeMinimalAsar } = require('./helpers/asar.js');
// The running app's own name: a rollback restarts it under that name (#794).
const { APP_NAME } = require('../src/main/app-identity');
const { removeTempDirSync } = require('./helpers/temp-dir');

const onWindows = process.platform === 'win32';
const EXE = `${APP_NAME}.exe`;
const FOLDER = `${APP_NAME}-win32-x64`;
const VERSION = '1.13.0';
const SERVICE = path.join(__dirname, '..', 'src', 'main', 'services', 'update-service.js');

const STAND_IN_SOURCE = `
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

static class StandIn {
  static int Main() {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string[] config = File.ReadAllLines(Path.Combine(dir, "stand-in.txt"));
    string label = File.ReadAllText(Path.Combine(dir, "version")).Trim();
    File.AppendAllText(config[1], label + " " + Process.GetCurrentProcess().Id + "\\n");
    switch (config[0]) {
      case "confirm":
        ProcessStartInfo info = new ProcessStartInfo(config[2], "\\"" + config[3] + "\\"");
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        using (Process confirm = Process.Start(info)) {
          confirm.WaitForExit();
          if (confirm.ExitCode != 0) return 9;
        }
        Thread.Sleep(1000);
        return 0;
      case "crash":
        return 3;
      case "hang":
        for (;;) Thread.Sleep(1000);
      default:
        return 0;
    }
  }
}
`;

const CONFIRM_SCRIPT = [
  "const { service, version, userData } = require(require('node:path').join(__dirname, 'confirm.json'));",
  'require(service).createUpdateService({ app: { getVersion: () => version, getPath: () => userData } })',
  '  .confirmInstallStarted().then((ok) => process.exit(ok ? 0 : 9));',
  '',
].join('\n');

let standInExe = '';
before(() => {
  if (!onWindows) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-stand-in-'));
  const source = path.join(dir, 'stand-in.cs');
  standInExe = path.join(dir, 'stand-in.exe');
  fs.writeFileSync(source, STAND_IN_SOURCE, 'utf8');
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${source}') -OutputAssembly '${standInExe}'`
      + ' -OutputType ConsoleApplication -IgnoreWarnings',
  ]);
});
after(() => {
  if (standInExe) removeTempDirSync(path.dirname(standInExe));
});

/** A copy of the stand-in as the app's .exe in `folder`, labelled `label`. */
async function placeStandIn(fixture, folder, label, behaviour) {
  await fsp.mkdir(folder, { recursive: true });
  await fsp.copyFile(standInExe, path.join(folder, EXE));
  await fsp.writeFile(path.join(folder, 'version'), label);
  await fsp.writeFile(path.join(folder, 'stand-in.txt'),
    [behaviour, fixture.started, process.execPath, fixture.confirmScript].join('\r\n'));
}

function readLines(file) {
  return readIfThere(file).split(/\r?\n/).filter(Boolean);
}

/** `[label, pid]` for every stand-in that ran. */
function startedStandIns(fixture) {
  return readLines(fixture.started).map((line) => {
    const [label, pid] = line.split(' ');
    return [label, Number(pid)];
  });
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A process that sits in `cwd` for `ms` milliseconds, like the app did. */
function holdFolder(cwd, ms) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { cwd, stdio: 'ignore' });
  return child;
}

/**
 * `what` is a function, so the message shows the state at the timeout. With a
 * `fixture`, the wait also ends in time to report before the test's own timeout
 * cuts it off without a word (#742).
 */
async function waitFor(check, { timeoutMs, what, fixture }) {
  const deadline = Math.min(Date.now() + timeoutMs, fixture ? fixture.deadline : Infinity);
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function readIfThere(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Leaves this much of the test's timeout for waitFor to report in. */
const REPORT_MARGIN_MS = 5_000;

/** Notes how far into the test a step got, for describe(). */
function mark(fixture, step) {
  fixture.steps.push(`${step} after ${Date.now() - fixture.startedAt} ms`);
}

/**
 * An installed old version and, beside it, the new one: packed as the release
 * ZIP for `install()`, or unpacked as the installer leaves it for the swap
 * script (`staged`). `newBehaviour` is what the new stand-in does.
 */
async function makeFixture(t, timeoutMs, { newBehaviour = 'confirm', staged = false } = {}) {
  const startedAt = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-swap-'));
  const holders = [];
  const userData = path.join(dir, 'userData');
  await fsp.mkdir(userData);
  const parentDir = path.join(dir, 'my tools');
  const fixture = {
    startedAt,
    deadline: startedAt + timeoutMs - REPORT_MARGIN_MS,
    steps: [],
    dir,
    parentDir,
    installDir: path.join(parentDir, FOLDER),
    holders,
    userData,
    started: path.join(dir, 'started.txt'),
    confirmScript: path.join(dir, 'confirm.js'),
    // The names update-service.js gives them.
    logFile: path.join(userData, 'update-install.log'),
    statusFile: path.join(userData, 'update-install-failed.json'),
    pendingFile: path.join(userData, 'update-install-pending.json'),
  };
  t.after(async () => {
    for (const child of holders) child.kill();
    for (const [, pid] of startedStandIns(fixture)) {
      try { process.kill(pid); } catch { /* gone already */ }
    }
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
  });

  // What the app does once its window is open. The script itself is fixed;
  // what it needs comes from the JSON file next to it.
  await fsp.writeFile(path.join(dir, 'confirm.json'), JSON.stringify({ service: SERVICE, version: VERSION, userData }));
  await fsp.writeFile(fixture.confirmScript, CONFIRM_SCRIPT);

  await placeStandIn(fixture, fixture.installDir, 'old', 'exit');
  // The user kept the downloaded ZIP next to the program.
  await fsp.writeFile(path.join(fixture.installDir, `${FOLDER}-1.12.0.zip`), 'the old download');

  if (staged) {
    fixture.stageRoot = path.join(parentDir, '.snotra-new-1');
    fixture.stagedDir = path.join(fixture.stageRoot, FOLDER);
    fixture.backupDir = path.join(parentDir, '.snotra-old-1');
    await placeStandIn(fixture, fixture.stagedDir, 'new', newBehaviour);
  } else {
    // The release ZIP has a top-level folder, as electron-forge packs it.
    const packageDir = path.join(dir, 'package', FOLDER);
    await placeStandIn(fixture, packageDir, 'new', newBehaviour);
    // The installer reads name and version from the package before the swap (#569).
    await fsp.mkdir(path.join(packageDir, 'resources'));
    writeMinimalAsar(path.join(packageDir, 'resources', 'app.asar'), {
      'package.json': JSON.stringify({ productName: APP_NAME, version: VERSION }),
    });
    fixture.zip = path.join(dir, `${FOLDER}-${VERSION}.zip`);
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -LiteralPath '${packageDir}' -DestinationPath '${fixture.zip}'`,
    ]);
  }
  mark(fixture, 'fixture ready');
  return fixture;
}

/**
 * Starts the install the way the app does: from inside its own folder, and
 * with the installer's own launcher — detached, as it has to outlive the app.
 */
async function installFromInsideTheFolder(fixture, pid) {
  const installer = createUpdateInstaller({ getPid: () => pid });
  const before = process.cwd();
  process.chdir(fixture.installDir);
  try {
    return await installer.install({
      filePath: fixture.zip,
      version: VERSION,
      target: { kind: 'windows-dir', canSelfUpdate: true, installDir: fixture.installDir },
      workDir: path.join(fixture.dir, 'work'),
      logFile: fixture.logFile,
      statusFile: fixture.statusFile,
      pendingFile: fixture.pendingFile,
    });
  } finally {
    process.chdir(before);
  }
}

const INSTALLER = path.join(__dirname, '..', 'src', 'main', 'services', 'update-installer.js');

/**
 * Starts the install from a process of its own that quits as soon as
 * `install()` returns, the way the app does (#654). That process is also the
 * one the helper waits for. On Windows a child spawned without `detached` sits
 * in a job that closes, killing what is in it, when its parent exits — the
 * helper has to be outside it by then.
 */
async function installFromAProcessThatQuits(fixture) {
  const resultFile = path.join(fixture.dir, 'install-result.json');
  const options = {
    filePath: fixture.zip,
    version: VERSION,
    target: { kind: 'windows-dir', canSelfUpdate: true, installDir: fixture.installDir },
    workDir: path.join(fixture.dir, 'work'),
    logFile: fixture.logFile,
    statusFile: fixture.statusFile,
    pendingFile: fixture.pendingFile,
  };
  const code = [
    `const { createUpdateInstaller } = require(${JSON.stringify(INSTALLER)});`,
    `createUpdateInstaller().install(${JSON.stringify(options)}).then((res) => {`,
    `  require('node:fs').writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(res));`,
    '  process.exit(0);',
    '});',
  ].join('\n');
  // No pipes: a helper that inherited one would keep this test waiting on it.
  const app = spawn(process.execPath, ['-e', code], { cwd: fixture.installDir, stdio: 'ignore' });
  const exitCode = await new Promise((resolve, reject) => {
    app.on('error', reject);
    app.on('exit', resolve);
  });
  assert.equal(exitCode, 0, 'the stand-in app ends normally');
  return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

function describe(fixture) {
  return [
    'the helper',
    `output: ${readIfThere(helperOutputFile(fixture.logFile)) || '(none)'}`,
    `log: ${readIfThere(fixture.logFile) || '(none)'}`,
    `status: ${readIfThere(fixture.statusFile) || '(none)'}`,
    `pending: ${readIfThere(fixture.pendingFile) || '(none)'}`,
    `stand-ins: ${readLines(fixture.started).join(', ') || '(none)'}`,
    `launcher: ${readIfThere(path.join(fixture.dir, 'work', 'helper-launch.json')) || '(none)'}`,
    `next to the app: ${fs.readdirSync(fixture.parentDir).join(', ')}`,
    `steps: ${fixture.steps.join('; ')}; waited until ${Date.now() - fixture.startedAt} ms`,
  ].join('\n');
}

/** What PowerShell's parser objects to in `script`, one line per error. */
function parseErrors(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-parse-'));
  try {
    const file = path.join(dir, 'script.ps1');
    fs.writeFileSync(file, script, 'utf8');
    return execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); `
        + '$e | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ": " + $_.Message }',
    ], { encoding: 'utf8' }).trim();
  } finally {
    removeTempDirSync(dir);
  }
}

test('Windows: the swap script parses', { skip: !onWindows }, () => {
  const script = buildWindowsSwapScript({
    pid: 1,
    installDir: `C:\\a\\${APP_NAME}`,
    stagedDir: 'C:\\a\\.snotra-new-1\\x',
    stageRoot: 'C:\\a\\.snotra-new-1',
    backupDir: 'C:\\a\\.snotra-old-1',
    workDir: 'C:\\t\\w',
    logFile: 'C:\\t\\l.log',
    statusFile: 'C:\\t\\s.json',
    pendingFile: 'C:\\t\\p.json',
    startedFile: 'C:\\t\\w\\helper-started',
    version: '1.13.0',
    carryOver: ["Kon's.zip"],
  });
  const errors = parseErrors(script);
  assert.equal(errors, '', errors);
});

test('Windows: the helper launcher parses', { skip: !onWindows }, () => {
  const text = buildWindowsLaunchCommand({
    script: 'C:\\t\\Kon Rad\\swap.ps1',
    cwd: "C:\\a\\Kon's tools",
    outputFile: 'C:\\t\\out.log',
    startedFile: 'C:\\t\\w\\helper-started',
    resultFile: 'C:\\t\\w\\helper-launch.json',
  });
  const errors = parseErrors(text);
  assert.equal(errors, '', errors);
});

test('Windows: the swap goes through although the app ran from its own folder', { skip: !onWindows, timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture(t, 90_000);
  const app = holdFolder(fixture.installDir, 2000);
  fixture.holders.push(app);

  const res = await installFromInsideTheFolder(fixture, app.pid);
  mark(fixture, 'install() returned');
  assert.equal(res.ok, true, JSON.stringify(res));

  const log = await waitFor(() => /updated to 1\.13\.0/.test(readIfThere(fixture.logFile)) && readIfThere(fixture.logFile), {
    timeoutMs: 60_000,
    what: () => describe(fixture),
    fixture,
  });
  assert.equal(readIfThere(path.join(fixture.installDir, 'version')), 'new', log);
  assert.equal(readIfThere(path.join(fixture.installDir, `${FOLDER}-1.12.0.zip`)), 'the old download');
  assert.deepEqual(fs.readdirSync(fixture.parentDir), [FOLDER], 'no staging or backup folder is left behind');
  assert.equal(fs.existsSync(fixture.statusFile), false);
  assert.equal(fs.existsSync(fixture.pendingFile), false, 'the new version confirmed its start');
  assert.equal(fs.existsSync(path.join(fixture.dir, 'work')), false);
  // #1067: the backup went only after the new version had confirmed.
  assert.ok(log.indexOf('starting the new version') < log.indexOf('updated to 1.13.0'), log);
  assert.deepEqual(startedStandIns(fixture).map(([label]) => label), ['new']);
});

// #654: what broke in the field from v1.12.2 on. The process that started the
// helper quits, and the helper went down with it before it had moved anything.
test('Windows: the helper outlives the app that started it', { skip: !onWindows, timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture(t, 90_000);

  const res = await installFromAProcessThatQuits(fixture);
  mark(fixture, 'install() returned');
  assert.equal(res.ok, true, JSON.stringify(res));

  const log = await waitFor(() => /updated to 1\.13\.0/.test(readIfThere(fixture.logFile)) && readIfThere(fixture.logFile), {
    timeoutMs: 60_000,
    what: () => describe(fixture),
    fixture,
  });
  assert.equal(readIfThere(path.join(fixture.installDir, 'version')), 'new', log);
  assert.deepEqual(fs.readdirSync(fixture.parentDir), [FOLDER], 'no staging or backup folder is left behind');
});

test('Windows: a folder that stays locked rolls back, reports and keeps the old version', { skip: !onWindows, timeout: 120_000 }, async (t) => {
  const fixture = await makeFixture(t, 120_000);
  const app = holdFolder(fixture.installDir, 1000);
  // Something else keeps the folder for longer than the helper retries.
  const lock = holdFolder(fixture.installDir, 60_000);
  fixture.holders.push(app, lock);

  const res = await installFromInsideTheFolder(fixture, app.pid);
  mark(fixture, 'install() returned');
  assert.equal(res.ok, true, JSON.stringify(res));

  const status = await waitFor(() => readIfThere(fixture.statusFile), {
    timeoutMs: 90_000,
    what: () => describe(fixture),
    fixture,
  });
  const record = JSON.parse(status.replace(/^\uFEFF/, ''));
  assert.equal(record.version, '1.13.0');
  assert.equal(record.log, fixture.logFile);
  assert.ok(record.error, 'the reason is recorded');

  const log = await waitFor(() => /starting the previous version again/.test(readIfThere(fixture.logFile)) && readIfThere(fixture.logFile), {
    timeoutMs: 10_000,
    what: () => describe(fixture),
    fixture,
  });
  assert.match(log, /update failed: /);
  assert.equal(record.stage, 'swap');
  assert.equal(readIfThere(path.join(fixture.installDir, 'version')), 'old');
  assert.deepEqual(fs.readdirSync(fixture.parentDir), [FOLDER], 'the unpacked new version is cleared away');
});

/**
 * Runs the swap script on a staged folder, as the launcher would, and returns
 * its exit code. `pid` is a process that quits right away, like the app.
 */
async function runSwapScript(fixture, { startSeconds }) {
  const app = holdFolder(fixture.installDir, 500);
  fixture.holders.push(app);
  const workDir = path.join(fixture.dir, 'work');
  await fsp.mkdir(workDir, { recursive: true });
  const script = path.join(workDir, 'swap.ps1');
  await fsp.writeFile(script, buildWindowsSwapScript({
    pid: app.pid,
    installDir: fixture.installDir,
    stagedDir: fixture.stagedDir,
    stageRoot: fixture.stageRoot,
    backupDir: fixture.backupDir,
    workDir,
    logFile: fixture.logFile,
    statusFile: fixture.statusFile,
    pendingFile: fixture.pendingFile,
    startedFile: path.join(workDir, 'helper-started'),
    version: VERSION,
    carryOver: [`${FOLDER}-1.12.0.zip`],
    exeName: EXE,
    startSeconds,
  }), 'utf8');
  const helper = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], { cwd: fixture.dir, stdio: 'ignore' });
  fixture.holders.push(helper);
  mark(fixture, 'helper started');
  const code = await new Promise((resolve, reject) => {
    helper.on('error', reject);
    helper.on('exit', resolve);
  });
  mark(fixture, `helper ended with ${code}`);
  return code;
}

/**
 * What a rollback after the start has to leave (#1067): the old version back
 * in place with what the user kept there, started again; nothing beside it;
 * a status record with stage `start` that the next start reports.
 */
async function assertRolledBack(fixture, reason) {
  const status = readIfThere(fixture.statusFile);
  assert.ok(status, describe(fixture));
  const record = JSON.parse(status.replace(/^\uFEFF/, ''));
  assert.equal(record.version, VERSION);
  assert.equal(record.stage, 'start');
  assert.match(record.error, reason);
  assert.equal(record.log, fixture.logFile);

  assert.equal(readIfThere(path.join(fixture.installDir, 'version')), 'old', describe(fixture));
  assert.equal(readIfThere(path.join(fixture.installDir, `${FOLDER}-1.12.0.zip`)), 'the old download');
  assert.deepEqual(fs.readdirSync(fixture.parentDir), [FOLDER], describe(fixture));
  assert.equal(fs.existsSync(fixture.pendingFile), false);

  const log = readIfThere(fixture.logFile);
  assert.match(log, /starting the new version/);
  assert.match(log, /update failed: /);
  assert.match(log, /starting the previous version again/);
  assert.doesNotMatch(log, /updated to /);

  await waitFor(() => startedStandIns(fixture).some(([label]) => label === 'old'), {
    timeoutMs: 10_000,
    what: () => describe(fixture),
    fixture,
  });
  const [newOne] = startedStandIns(fixture);
  assert.equal(newOne[0], 'new');
  assert.equal(isRunning(newOne[1]), false, 'the new version is not left running');

  // The next start of the old version shows the reason next to the update.
  const failure = await createUpdateService({
    app: { getVersion: () => '1.12.0', getPath: () => fixture.userData },
  }).readInstallFailure();
  assert.equal(failure?.stage, 'start');
  assert.match(failure.error, reason);
}

test('Windows: a new version that ends before it confirms is rolled back, and the old one starts', { skip: !onWindows, timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture(t, 90_000, { staged: true, newBehaviour: 'crash' });
  const code = await runSwapScript(fixture, { startSeconds: 30 });
  assert.equal(code, 1, describe(fixture));
  await assertRolledBack(fixture, /the new version ended before it had started \(exit code 3\)/);
});

test('Windows: a new version that never confirms is stopped and rolled back', { skip: !onWindows, timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture(t, 90_000, { staged: true, newBehaviour: 'hang' });
  const code = await runSwapScript(fixture, { startSeconds: 5 });
  assert.equal(code, 1, describe(fixture));
  await assertRolledBack(fixture, /the new version did not start within 5 seconds/);
});
