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

const { createUpdateInstaller } = require('../src/main/services/update-installer');

const onWindows = process.platform === 'win32';
const EXE = 'Snotra AI.exe';
const FOLDER = 'Snotra AI-win32-x64';

/** A process that sits in `cwd` for `ms` milliseconds, like the app did. */
function holdFolder(cwd, ms) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { cwd, stdio: 'ignore' });
  return child;
}

async function waitFor(check, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
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

/** Starts the install the way the app does: from inside its own folder. */
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

test('Windows: the swap goes through although the app ran from its own folder', { skip: !onWindows, timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture(t);
  const app = holdFolder(fixture.installDir, 2000);
  fixture.holders.push(app);

  const res = await installFromInsideTheFolder(fixture, app.pid);
  assert.equal(res.ok, true, JSON.stringify(res));

  const log = await waitFor(() => /updated to 1\.13\.0/.test(readIfThere(fixture.logFile)) && readIfThere(fixture.logFile), {
    timeoutMs: 60_000,
    what: `the helper to finish (log so far: ${readIfThere(fixture.logFile)})`,
  });
  assert.equal(readIfThere(path.join(fixture.installDir, 'version')), 'new', log);
  assert.equal(readIfThere(path.join(fixture.installDir, `${FOLDER}-1.12.0.zip`)), 'the old download');
  assert.deepEqual(fs.readdirSync(fixture.parentDir), [FOLDER], 'no staging or backup folder is left behind');
  assert.equal(fs.existsSync(fixture.statusFile), false);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'work')), false);
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
    what: `the failure report (log so far: ${readIfThere(fixture.logFile)})`,
  });
  const record = JSON.parse(status.replace(/^\uFEFF/, ''));
  assert.equal(record.version, '1.13.0');
  assert.equal(record.log, fixture.logFile);
  assert.ok(record.error, 'the reason is recorded');

  const log = await waitFor(() => /starting the previous version again/.test(readIfThere(fixture.logFile)) && readIfThere(fixture.logFile), {
    timeoutMs: 10_000,
    what: 'the old version to be started again',
  });
  assert.match(log, /update failed: /);
  assert.equal(readIfThere(path.join(fixture.installDir, 'version')), 'old');
  assert.deepEqual(fs.readdirSync(fixture.parentDir), [FOLDER], 'the unpacked new version is cleared away');
});
