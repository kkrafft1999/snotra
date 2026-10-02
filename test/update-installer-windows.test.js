// The Windows folder swap, run for real (#442).
//
// Everything else about the installer is checked as text; this file runs the
// actual PowerShell helper on the Windows CI runner. It rebuilds the case that
// broke in the field: the app was started from its own folder, so that folder
// is a process's working directory, which Windows will not let anyone rename.
//
// A copy of hostname.exe stands in for "Snotra AI.exe" — it starts, prints and
// exits, so the relaunch at the end of the helper leaves nothing running.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const {
  createUpdateInstaller,
  buildWindowsSwapScript,
  helperOutputFile,
} = require('../src/main/services/update-installer');
const { writeMinimalAsar } = require('./helpers/asar.js');

const onWindows = process.platform === 'win32';
const EXE = 'Snotra AI.exe';
const FOLDER = 'Snotra AI-win32-x64';

/** A process that sits in `cwd` for `ms` milliseconds, like the app did. */
function holdFolder(cwd, ms) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { cwd, stdio: 'ignore' });
  return child;
}

/** `what` is a function, so the message shows the state at the timeout. */
async function waitFor(check, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
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

async function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-swap-'));
  const holders = [];
  t.after(async () => {
    for (const child of holders) child.kill();
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
  });

  const hostname = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'HOSTNAME.EXE');
  const parentDir = path.join(dir, 'my tools');
  const installDir = path.join(parentDir, FOLDER);
  await fsp.mkdir(installDir, { recursive: true });
  await fsp.copyFile(hostname, path.join(installDir, EXE));
  await fsp.writeFile(path.join(installDir, 'version'), 'old');
  // The user kept the downloaded ZIP next to the program.
  await fsp.writeFile(path.join(installDir, `${FOLDER}-1.12.0.zip`), 'the old download');

  // The release ZIP has a top-level folder, as electron-forge packs it.
  const packageDir = path.join(dir, 'package', FOLDER);
  await fsp.mkdir(packageDir, { recursive: true });
  await fsp.copyFile(hostname, path.join(packageDir, EXE));
  await fsp.writeFile(path.join(packageDir, 'version'), 'new');
  // The installer reads name and version from the package before the swap (#569).
  await fsp.mkdir(path.join(packageDir, 'resources'));
  writeMinimalAsar(path.join(packageDir, 'resources', 'app.asar'), {
    'package.json': JSON.stringify({ productName: 'Snotra AI', version: '1.13.0' }),
  });
  const zip = path.join(dir, `${FOLDER}-1.13.0.zip`);
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -LiteralPath '${packageDir}' -DestinationPath '${zip}'`,
  ]);

  const userData = path.join(dir, 'userData');
  await fsp.mkdir(userData);
  return {
    dir,
    parentDir,
    installDir,
    zip,
    holders,
    logFile: path.join(userData, 'update-install.log'),
    statusFile: path.join(userData, 'update-install-failed.json'),
  };
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
      version: '1.13.0',
      target: { kind: 'windows-dir', canSelfUpdate: true, installDir: fixture.installDir },
      workDir: path.join(fixture.dir, 'work'),
      logFile: fixture.logFile,
      statusFile: fixture.statusFile,
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
    version: '1.13.0',
    target: { kind: 'windows-dir', canSelfUpdate: true, installDir: fixture.installDir },
    workDir: path.join(fixture.dir, 'work'),
    logFile: fixture.logFile,
    statusFile: fixture.statusFile,
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
    `next to the app: ${fs.readdirSync(fixture.parentDir).join(', ')}`,
  ].join('\n');
}

test('Windows: the swap script parses', { skip: !onWindows }, () => {
  const script = buildWindowsSwapScript({
    pid: 1,
    installDir: 'C:\\a\\Snotra AI',
    stagedDir: 'C:\\a\\.snotra-new-1\\x',
    stageRoot: 'C:\\a\\.snotra-new-1',
    backupDir: 'C:\\a\\.snotra-old-1',
    workDir: 'C:\\t\\w',
    logFile: 'C:\\t\\l.log',
    statusFile: 'C:\\t\\s.json',
    version: '1.13.0',
    carryOver: ["Kon's.zip"],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-parse-'));
  try {
    const file = path.join(dir, 'swap.ps1');
    fs.writeFileSync(file, script, 'utf8');
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); `
        + '$e | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ": " + $_.Message }',
    ], { encoding: 'utf8' });
    assert.equal(out.trim(), '', out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows: the swap goes through although the app ran from its own folder', { skip: !onWindows, timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture(t);
  const app = holdFolder(fixture.installDir, 2000);
  fixture.holders.push(app);

  const res = await installFromInsideTheFolder(fixture, app.pid);
  assert.equal(res.ok, true, JSON.stringify(res));

  const log = await waitFor(() => /updated to 1\.13\.0/.test(readIfThere(fixture.logFile)) && readIfThere(fixture.logFile), {
    timeoutMs: 60_000,
    what: () => describe(fixture),
  });
  assert.equal(readIfThere(path.join(fixture.installDir, 'version')), 'new', log);
  assert.equal(readIfThere(path.join(fixture.installDir, `${FOLDER}-1.12.0.zip`)), 'the old download');
  assert.deepEqual(fs.readdirSync(fixture.parentDir), [FOLDER], 'no staging or backup folder is left behind');
  assert.equal(fs.existsSync(fixture.statusFile), false);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'work')), false);
});

// #654: what broke in the field from v1.12.2 on. The process that started the
// helper quits, and the helper went down with it before it had moved anything.
test('Windows: the helper outlives the app that started it', { skip: !onWindows, timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture(t);

  const res = await installFromAProcessThatQuits(fixture);
  assert.equal(res.ok, true, JSON.stringify(res));

  const log = await waitFor(() => /updated to 1\.13\.0/.test(readIfThere(fixture.logFile)) && readIfThere(fixture.logFile), {
    timeoutMs: 60_000,
    what: () => describe(fixture),
  });
  assert.equal(readIfThere(path.join(fixture.installDir, 'version')), 'new', log);
  assert.deepEqual(fs.readdirSync(fixture.parentDir), [FOLDER], 'no staging or backup folder is left behind');
});

test('Windows: a folder that stays locked rolls back, reports and keeps the old version', { skip: !onWindows, timeout: 120_000 }, async (t) => {
  const fixture = await makeFixture(t);
  const app = holdFolder(fixture.installDir, 1000);
  // Something else keeps the folder for longer than the helper retries.
  const lock = holdFolder(fixture.installDir, 60_000);
  fixture.holders.push(app, lock);

  const res = await installFromInsideTheFolder(fixture, app.pid);
  assert.equal(res.ok, true, JSON.stringify(res));

  const status = await waitFor(() => readIfThere(fixture.statusFile), {
    timeoutMs: 90_000,
    what: () => describe(fixture),
  });
  const record = JSON.parse(status.replace(/^\uFEFF/, ''));
  assert.equal(record.version, '1.13.0');
  assert.equal(record.log, fixture.logFile);
  assert.ok(record.error, 'the reason is recorded');

  const log = await waitFor(() => /starting the previous version again/.test(readIfThere(fixture.logFile)) && readIfThere(fixture.logFile), {
    timeoutMs: 10_000,
    what: () => describe(fixture),
  });
  assert.match(log, /update failed: /);
  assert.equal(readIfThere(path.join(fixture.installDir, 'version')), 'old');
  assert.deepEqual(fs.readdirSync(fixture.parentDir), [FOLDER], 'the unpacked new version is cleared away');
});
