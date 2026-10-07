'use strict';

// Tauscht die installierte App gegen die frisch geladene aus und startet neu.
//
// Der eigentliche Tausch kann nicht im laufenden Prozess passieren: Unter
// Windows ist die laufende .exe gesperrt, unter Linux haengt das AppImage als
// Dateisystem im eigenen Prozess. Deshalb ist das Muster ueberall gleich —
// die neue Version wird **neben** der alten fertig ausgepackt und geprueft,
// danach uebernimmt ein losgeloestes Helferskript: warten, bis diese App
// beendet ist, umbenennen, alte Version loeschen, neu starten.
//
// Alles, was vor dem Neustart schiefgehen kann, geht vorher schief: fehlende
// Schreibrechte, ein kaputtes Archiv, eine falsche Version im Paket. Nach dem
// `rename` gibt es nur noch den Rueckweg auf die gesicherte alte Version.
//
// What is verified, per platform (#569): the download's SHA-256 against the
// release everywhere (update-download.js); on macOS the DMG's own checksum,
// the bundle identifier and the version in Info.plist; in a Windows or Linux
// folder the product name and the version in the package's `package.json`.
// The AppImage is a single file and is checked by its checksum only.

const fs = require('fs');
const fsp = require('fs/promises');
// Inside Electron, `fs` treats an `.asar` file as a folder and will not hand
// out its raw bytes; `original-fs` is the unpatched module. Outside Electron
// (the tests) there is no such module and plain `fs` does the same job.
const rawFs = (() => {
  try { return require('original-fs'); } catch { return fs; }
})();
const path = require('path');
const { execFile, spawn } = require('child_process');

const { APP_NAME, APP_BUNDLE_ID, PRODUCT_NAMES } = require('../app-identity');
const { createMessage } = require('../../shared/contracts/message');
const { translateMessage } = require('../../shared/i18n');

/**
 * An error for the update dialog (#353). `userMessage` is a key the dialog
 * words in the interface language; `message` stays English, for the log.
 */
function installError(key, params) {
  const userMessage = createMessage(key, params);
  const err = new Error(translateMessage('en', userMessage));
  err.userMessage = userMessage;
  return err;
}

const MAC_BUNDLE_NAME = `${APP_NAME}.app`;
const WINDOWS_EXE_NAME = `${APP_NAME}.exe`;
const LINUX_BINARY_NAME = APP_NAME;

// What a package of this app may be called, before and after the rename to
// Snotra Agent (#794).
const MAC_BUNDLE_NAMES = PRODUCT_NAMES.map((name) => `${name}.app`);
const WINDOWS_EXE_NAMES = PRODUCT_NAMES.map((name) => `${name}.exe`);
const LINUX_BINARY_NAMES = PRODUCT_NAMES;

/** The first of `names` that exists in `dir`, or ''. */
function findExecutable(dir, names) {
  return names.find((name) => fs.existsSync(path.join(dir, name))) || '';
}

/**
 * Where the new Mac bundle goes (#794). A bundle under one of the app's own
 * names takes the name the disk image gives it, so `Snotra AI.app` becomes
 * `Snotra Agent.app` with the update that brings the rename. A bundle the user
 * named differently keeps its path, and so does one whose new name is taken
 * already — by a copy installed by hand, say.
 */
function macTargetBundlePath(appBundlePath, imageBundleName, exists = fs.existsSync) {
  // A Mac path, on whatever machine the tests run (#796).
  const current = path.posix.basename(appBundlePath);
  if (!MAC_BUNDLE_NAMES.includes(current) || !MAC_BUNDLE_NAMES.includes(imageBundleName)) return appBundlePath;
  if (imageBundleName === current) return appBundlePath;
  const renamed = path.posix.join(path.posix.dirname(appBundlePath), imageBundleName);
  return exists(renamed) ? appBundlePath : renamed;
}

/** Pfad fuer ein POSIX-Shell-Skript einbetten. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Pfad fuer ein PowerShell-Skript einbetten (einfache Anfuehrungszeichen verdoppeln). */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * macOS/Linux: auf das Ende dieses Prozesses warten, dann aufraeumen und
 * starten. `kill -0` prueft nur die Existenz der PID, es wird nichts beendet.
 */
function buildPosixWaitPrefix(pid) {
  return [
    '#!/bin/sh',
    `pid=${Number(pid)}`,
    'i=0',
    'while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do',
    '  sleep 0.2',
    '  i=$((i+1))',
    'done',
  ].join('\n');
}

function buildMacRelaunchScript({ pid, appBundlePath, backupPath, workDir }) {
  return [
    buildPosixWaitPrefix(pid),
    `rm -rf ${shQuote(backupPath)}`,
    `rm -rf ${shQuote(workDir)}`,
    `open ${shQuote(appBundlePath)}`,
    '',
  ].join('\n');
}

function buildLinuxAppImageScript({ pid, appImagePath, stagedPath, workDir }) {
  return [
    buildPosixWaitPrefix(pid),
    `mv -f ${shQuote(stagedPath)} ${shQuote(appImagePath)} || exit 1`,
    `chmod 755 ${shQuote(appImagePath)}`,
    `rm -rf ${shQuote(workDir)}`,
    `exec ${shQuote(appImagePath)}`,
    '',
  ].join('\n');
}

function buildLinuxDirScript({ pid, installDir, stagedDir, backupDir, workDir, binaryName = LINUX_BINARY_NAME }) {
  return [
    buildPosixWaitPrefix(pid),
    `mv ${shQuote(installDir)} ${shQuote(backupDir)} || exit 1`,
    // Scheitert der zweite Zug, steht die alte Version wieder da — besser eine
    // nicht aktualisierte App als gar keine.
    `if ! mv ${shQuote(stagedDir)} ${shQuote(installDir)}; then`,
    `  mv ${shQuote(backupDir)} ${shQuote(installDir)}`,
    '  exit 1',
    'fi',
    `rm -rf ${shQuote(backupDir)}`,
    `rm -rf ${shQuote(workDir)}`,
    `exec ${shQuote(path.posix.join(installDir, binaryName))}`,
    '',
  ].join('\n');
}

/**
 * Windows: wait for this process to end, swap the folders, start again.
 *
 * Everything here has to hold up against a folder Windows will not let go of
 * (#442). The helper therefore runs from the parent folder — a directory that
 * is some process's current directory cannot be renamed, and the app is
 * usually started from its own folder. Each move is retried for a while,
 * because a scanner or a sync client often holds a file for a moment. And a
 * failure is never silent: the helper logs every step, rolls back, leaves a
 * status file for the next start and restarts the old version.
 *
 * `carryOver` lists entries of the app folder that are not part of the new
 * package (the downloaded ZIP, say). They move into the new folder instead of
 * being deleted along with the backup.
 *
 * `startedFile` is written as soon as the script runs, before it waits for
 * the app: the launcher holds the app back until it sees that file (#654).
 */
function buildWindowsSwapScript({
  pid, installDir, stagedDir, stageRoot = stagedDir, backupDir, workDir,
  logFile, statusFile, startedFile, version = '', carryOver = [], exeName = WINDOWS_EXE_NAME,
  previousExeName = exeName,
}) {
  const carry = carryOver.length > 0 ? `@(${carryOver.map(psQuote).join(', ')})` : '@()';
  return [
    '$ErrorActionPreference =' + " 'Stop'",
    `$procId  = ${Number(pid)}`,
    `$install = ${psQuote(installDir)}`,
    `$staged  = ${psQuote(stagedDir)}`,
    `$stage   = ${psQuote(stageRoot)}`,
    `$backup  = ${psQuote(backupDir)}`,
    `$work    = ${psQuote(workDir)}`,
    `$log     = ${psQuote(logFile)}`,
    `$status  = ${psQuote(statusFile)}`,
    `$started = ${psQuote(startedFile)}`,
    `$version = ${psQuote(version)}`,
    `$carry   = ${carry}`,
    `$exe     = Join-Path $install ${psQuote(exeName)}`,
    // After a rollback the old folder is back, and with it the old name (#794).
    `$oldExe  = Join-Path $install ${psQuote(previousExeName)}`,
    '',
    'function Write-Log([string]$text) {',
    "  try { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $text) -Encoding UTF8 } catch { }",
    '}',
    '',
    'function Move-WithRetry([string]$from, [string]$to) {',
    '  for ($i = 1; ; $i++) {',
    '    try { Move-Item -LiteralPath $from -Destination $to -Force; return }',
    '    catch {',
    '      if ($i -ge 40) { throw }',
    "      Write-Log ('move ' + $from + ' failed (attempt ' + $i + '): ' + $_.Exception.Message)",
    '      Start-Sleep -Milliseconds 500',
    '    }',
    '  }',
    '}',
    '',
    'Set-Location -LiteralPath (Split-Path -Parent $install)',
    "Write-Log ('update to ' + $version + ': waiting for process ' + $procId)",
    'Set-Content -LiteralPath $started -Value $PID -Encoding ASCII',
    '$deadline = (Get-Date).AddSeconds(120)',
    'while ((Get-Date) -lt $deadline) {',
    '  if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { break }',
    '  Start-Sleep -Milliseconds 250',
    '}',
    // Windows gibt Dateihandles erst kurz nach dem Prozessende frei.
    'Start-Sleep -Milliseconds 1000',
    '',
    'try {',
    '  Move-WithRetry $install $backup',
    '  try {',
    "    if (Test-Path -LiteralPath $install) { throw ($install + ' still exists') }",
    '    Move-WithRetry $staged $install',
    '  } catch {',
    '    Move-WithRetry $backup $install',
    '    throw',
    '  }',
    '} catch {',
    '  $reason = $_.Exception.Message',
    "  Write-Log ('update failed: ' + $reason)",
    '  try {',
    '    @{ version = $version; error = $reason; log = $log; at = (Get-Date -Format o) } |',
    '      ConvertTo-Json | Set-Content -LiteralPath $status -Encoding UTF8',
    '  } catch { }',
    '  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
    '  if (Test-Path -LiteralPath $oldExe) {',
    "    Write-Log 'starting the previous version again'",
    '    Start-Process -FilePath $oldExe',
    '  } else {',
    "    Write-Log ('the previous version is in ' + $backup)",
    '  }',
    '  exit 1',
    '}',
    '',
    '$keepBackup = $false',
    'foreach ($name in $carry) {',
    '  try { Move-WithRetry (Join-Path $backup $name) (Join-Path $install $name) }',
    "  catch { $keepBackup = $true; Write-Log ('could not carry over ' + $name + ': ' + $_.Exception.Message) }",
    '}',
    'Remove-Item -LiteralPath $status -Force -ErrorAction SilentlyContinue',
    'if ($keepBackup) {',
    "  Write-Log ('kept the previous folder as ' + $backup)",
    '} else {',
    '  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue',
    '}',
    'Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
    'Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue',
    "Write-Log ('updated to ' + $version)",
    'Start-Process -FilePath $exe',
    '',
  ].join('\n');
}

/** How long the launcher waits for the swap script to report that it runs. */
const WINDOWS_HELPER_START_SECONDS = 30;

/**
 * Windows: the first stage of the helper start (#654).
 *
 * A child that Node spawns without `detached` is put into a job that kills
 * it when this process exits — exactly when the swap script has to do its
 * work. A process that such a child starts in turn is no longer part of that
 * job. So this stage, run as a child of the app, only starts the swap script
 * with `Start-Process`, waits until the script has written `startedFile`, and
 * ends. The app quits only after that; until then it can still show an error.
 *
 * What the swap script prints while starting goes to `outputFile`, and is
 * quoted when it ends before reporting. The outcome lands in `resultFile` as
 * `{ ok: true, pid }` or `{ ok: false, error }`: this stage runs without
 * stdio, since a pipe inherited by the swap script would keep the app waiting
 * on a process that is itself waiting for the app.
 */
function buildWindowsLaunchCommand({
  script, cwd, outputFile, startedFile, resultFile, timeoutSeconds = WINDOWS_HELPER_START_SECONDS,
}) {
  // Start-Process joins its argument list with spaces and quotes nothing;
  // a Windows path cannot contain a double quote.
  const helperArgs = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
  const seconds = Number(timeoutSeconds);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$result  = ${psQuote(resultFile)}`,
    `$output  = ${psQuote(outputFile)}`,
    `$started = ${psQuote(startedFile)}`,
    'function Write-Result($value) {',
    '  $value | ConvertTo-Json -Compress | Set-Content -LiteralPath $result -Encoding UTF8',
    '}',
    'try {',
    `  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList ${psQuote(helperArgs)}`
      + ` -WorkingDirectory ${psQuote(cwd)} -WindowStyle Hidden -RedirectStandardError $output -PassThru`,
    // Without the handle .NET forgets the exit code of a process it did not wait for.
    '  $null = $p.Handle',
    `  $deadline = (Get-Date).AddSeconds(${seconds})`,
    '  while (-not (Test-Path -LiteralPath $started)) {',
    '    if ($p.HasExited) {',
    "      $said = ''",
    '      try { $said = [string](Get-Content -LiteralPath $output -Raw) } catch { }',
    "      throw ('the helper ended before it started (exit code ' + $p.ExitCode + '). ' + $said.Trim())",
    '    }',
    '    if ((Get-Date) -gt $deadline) {',
    '      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue',
    `      throw 'the helper did not report back within ${seconds} seconds'`,
    '    }',
    '    Start-Sleep -Milliseconds 100',
    '  }',
    '  Write-Result @{ ok = $true; pid = $p.Id }',
    '} catch {',
    '  Write-Result @{ ok = $false; error = $_.Exception.Message.Trim() }',
    '}',
    '',
  ].join('\n');
}

/** A PowerShell script as `-EncodedCommand` wants it: UTF-16LE, base64. */
function encodePowerShell(text) {
  return Buffer.from(text, 'utf16le').toString('base64');
}

/** Largest asar header this reader accepts; the app's own is a few hundred KB. */
const MAX_ASAR_HEADER_BYTES = 64 * 1024 * 1024;

/**
 * `package.json` from an `app.asar`, read straight from the archive (#569).
 *
 * The format: a 16-byte prefix whose second word is the size of the header
 * block and whose fourth is the length of the JSON header; the files follow
 * the header block, each at the `offset` the header names.
 *
 * @returns {object} the parsed package.json
 * @throws when the archive cannot be read or has no package.json
 */
function readAsarPackageJson(asarPath, fsImpl = rawFs) {
  const fd = fsImpl.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fsImpl.readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error('truncated archive');
    const headerBlock = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    if (jsonLength === 0 || jsonLength > MAX_ASAR_HEADER_BYTES || jsonLength > headerBlock) {
      throw new Error('implausible archive header');
    }
    const json = Buffer.alloc(jsonLength);
    if (fsImpl.readSync(fd, json, 0, jsonLength, 16) !== jsonLength) throw new Error('truncated archive');
    const entry = JSON.parse(json.toString('utf8'))?.files?.['package.json'];
    const size = Number(entry?.size);
    const offset = Number(entry?.offset);
    if (!entry || entry.unpacked || !Number.isSafeInteger(size) || !Number.isSafeInteger(offset)) {
      throw new Error('no package.json in the archive');
    }
    const data = Buffer.alloc(size);
    if (fsImpl.readSync(fd, data, 0, size, 8 + headerBlock + offset) !== size) throw new Error('truncated archive');
    return JSON.parse(data.toString('utf8'));
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * What the Windows launcher left in `resultFile`. PowerShell writes UTF-8 with
 * a byte order mark; no file means the launcher itself did not get that far.
 */
async function readLaunchResult(resultFile, exitCode) {
  let raw;
  try {
    raw = await fsp.readFile(resultFile, 'utf8');
  } catch {
    return { ok: false, error: `the launcher ended with exit code ${exitCode} and left no result` };
  }
  try {
    const record = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (record?.ok === true) return { ok: true, pid: record.pid };
    return { ok: false, error: String(record?.error || 'no reason given') };
  } catch {
    return { ok: false, error: `the launcher left an unreadable result: ${raw.trim().slice(0, 200)}` };
  }
}

/** `update-install.log` → `update-install-output.log`, next to it. */
function helperOutputFile(logFile) {
  const ext = path.extname(logFile);
  return `${logFile.slice(0, logFile.length - ext.length)}-output${ext}`;
}

/**
 * Entries of the app folder that the new package does not bring along — the
 * ZIP the app came in, or files of the user's when the app was extracted into
 * a shared folder. The folder is swapped as a whole, so without this they
 * would go with the backup. Windows names are compared without case.
 */
async function listForeignEntries(installDir, packageDir) {
  const [installed, shipped] = await Promise.all([
    fsp.readdir(installDir).catch(() => []),
    fsp.readdir(packageDir).catch(() => []),
  ]);
  const known = new Set(shipped.map((name) => name.toLowerCase()));
  return installed.filter((name) => !known.has(name.toLowerCase()));
}

/**
 * @param {object} [deps]
 * @param {() => number} [deps.getPid]     Test-Haken; default process.pid.
 * @param {function} [deps.run]            (cmd, args) => Promise<stdout>; default execFile.
 * @param {function} [deps.spawnDetached]  Test-Haken fuer den Helferstart (macOS, Linux).
 * @param {function} [deps.runQuiet]       (cmd, args, options) => Promise<exit code>,
 *                                         without stdio; default spawn. Starts the
 *                                         Windows helper (#654).
 */
function createUpdateInstaller({ getPid, run, spawnDetached, runQuiet } = {}) {
  const pidOf = getPid || (() => process.pid);

  const exec = run || ((cmd, args, options = {}) => new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        const output = String(stderr || err.message).trim();
        err.userMessage = createMessage('update.error.commandFailed', { command: cmd, output });
        err.message = `${cmd} failed: ${output}`;
        reject(err);
        return;
      }
      resolve(String(stdout));
    });
  }));

  // On macOS and Linux a detached child outlives this process. Windows starts
  // its helper through `runQuiet` and a launcher of its own instead (#654).
  const launch = spawnDetached || ((cmd, args) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  });

  // No stdio at all: the swap script the child starts would inherit a pipe,
  // and reading it to the end would wait for that script — which in turn
  // waits for this app to quit.
  const quiet = runQuiet || ((cmd, args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  }));

  /** @param {string} placeKey  Catalogue key naming the folder, e.g. `update.place.appFolder`. */
  async function assertWritable(dir, placeKey) {
    try {
      await fsp.access(dir, fs.constants.W_OK);
    } catch {
      throw installError('update.error.notWritable', { placeKey, dir });
    }
  }

  /** Liest Info.plist eines .app-Bundles als Objekt (macOS-Bordmittel plutil). */
  async function readBundlePlist(bundlePath) {
    const json = await exec('/usr/bin/plutil', [
      '-convert', 'json', '-o', '-', path.join(bundlePath, 'Contents', 'Info.plist'),
    ]);
    return JSON.parse(json);
  }

  /**
   * Bevor irgendetwas getauscht wird: Ist im Paket wirklich die erwartete
   * Version derselben App? Ein vertauschtes Asset faellt hier auf, solange
   * die laufende Installation noch unversehrt ist.
   */
  async function verifyMacBundle(bundlePath, expectedVersion) {
    let plist;
    try {
      plist = await readBundlePlist(bundlePath);
    } catch (err) {
      throw installError('update.error.verifyFailed', { error: err?.userMessage || err.message });
    }
    const bundleId = plist?.CFBundleIdentifier;
    const version = plist?.CFBundleShortVersionString;
    if (bundleId !== APP_BUNDLE_ID) {
      throw installError('update.error.wrongApp', bundleId ? { id: bundleId } : { idKey: 'update.unknownValue' });
    }
    if (expectedVersion && version !== expectedVersion) {
      throw installError('update.error.wrongVersion', {
        ...(version ? { version } : { versionKey: 'update.unknownValue' }),
        expected: expectedVersion,
      });
    }
  }

  /**
   * A Windows or Linux package folder: does its `resources/app.asar` hold
   * this app, at the version that was announced? Without this, a release
   * whose package is not its tag would be installed, found "newer" again on
   * the restart, and offered for ever (#569, #570).
   */
  function verifyPackageFolder(packageDir, expectedVersion) {
    let pkg;
    try {
      pkg = readAsarPackageJson(path.join(packageDir, 'resources', 'app.asar'));
    } catch (err) {
      throw installError('update.error.verifyFailed', { error: err.message });
    }
    const name = typeof pkg?.productName === 'string' ? pkg.productName : '';
    const found = typeof pkg?.version === 'string' ? pkg.version : '';
    if (!PRODUCT_NAMES.includes(name)) {
      throw installError('update.error.wrongApp', name ? { id: name } : { idKey: 'update.unknownValue' });
    }
    if (expectedVersion && found !== expectedVersion) {
      throw installError('update.error.wrongVersion', {
        ...(found ? { version: found } : { versionKey: 'update.unknownValue' }),
        expected: expectedVersion,
      });
    }
  }

  async function installMacos({ filePath, version, target, workDir }) {
    const appBundlePath = target.appBundlePath;
    const parentDir = path.dirname(appBundlePath);
    await assertWritable(parentDir, 'update.place.appFolder');

    const stamp = Date.now();
    let targetPath = appBundlePath;
    const mountPoint = path.join(workDir, `mnt-${stamp}`);
    const stagedPath = path.join(parentDir, `.snotra-new-${stamp}.app`);
    const backupPath = path.join(parentDir, `.snotra-old-${stamp}.app`);

    await fsp.mkdir(mountPoint, { recursive: true });
    // Without `-noverify`: hdiutil checks the image's own checksums, the last
    // line of defence against damaged bytes when a release lists no digest.
    await exec('/usr/bin/hdiutil', [
      'attach', filePath, '-nobrowse', '-readonly', '-mountpoint', mountPoint,
    ]);
    try {
      const entries = await fsp.readdir(mountPoint);
      const bundleName = entries.find((name) => name.endsWith('.app')) || MAC_BUNDLE_NAME;
      targetPath = macTargetBundlePath(appBundlePath, bundleName);
      // `ditto` statt `cp`: es erhaelt Symlinks, Rechte und erweiterte
      // Attribute des Bundles — `cp -R` tut das nicht zuverlaessig.
      await exec('/usr/bin/ditto', [path.join(mountPoint, bundleName), stagedPath]);
    } finally {
      await exec('/usr/bin/hdiutil', ['detach', mountPoint, '-force']).catch(() => {});
    }

    try {
      await verifyMacBundle(stagedPath, version);
    } catch (err) {
      await fsp.rm(stagedPath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    // Die Datei kam nicht ueber den Browser, traegt also keine Quarantaene.
    // Trotzdem entfernen: ein geerbtes Attribut wuerde Gatekeeper beim
    // Neustart eine Warnung zeigen lassen, die hier niemand erwartet.
    await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', stagedPath]).catch(() => {});

    await fsp.rename(appBundlePath, backupPath);
    try {
      await fsp.rename(stagedPath, targetPath);
    } catch (err) {
      await fsp.rename(backupPath, appBundlePath).catch(() => {});
      await fsp.rm(stagedPath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const script = path.join(workDir, 'relaunch.sh');
    await fsp.writeFile(script, buildMacRelaunchScript({
      pid: pidOf(), appBundlePath: targetPath, backupPath, workDir,
    }), { mode: 0o700 });
    launch('/bin/sh', [script]);
    return { ok: true, relaunching: true };
  }

  async function installWindows({ filePath, version, target, workDir, logFile, statusFile }) {
    const installDir = target.installDir;
    const parentDir = path.win32.dirname(installDir);
    await assertWritable(parentDir, 'update.place.installFolder');

    const stamp = Date.now();
    const stagedDir = path.join(parentDir, `.snotra-new-${stamp}`);
    const backupDir = path.join(parentDir, `.snotra-old-${stamp}`);

    await exec('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath ${psQuote(filePath)} -DestinationPath ${psQuote(stagedDir)} -Force`,
    ]);

    // Das ZIP enthaelt den Inhalt des Paketordners, nicht den Ordner selbst.
    // Wenn ein Release das mal anders packt, eine Ebene tiefer nachsehen,
    // statt ein Verzeichnis ohne .exe einzuspielen.
    let rootDir = stagedDir;
    let exeName = findExecutable(rootDir, WINDOWS_EXE_NAMES);
    if (!exeName) {
      const entries = await fsp.readdir(stagedDir, { withFileTypes: true });
      const single = entries.length === 1 && entries[0].isDirectory() ? entries[0].name : '';
      exeName = single ? findExecutable(path.join(stagedDir, single), WINDOWS_EXE_NAMES) : '';
      if (exeName) {
        rootDir = path.join(stagedDir, single);
      } else {
        await fsp.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
        throw installError('update.error.archiveMissing', { file: WINDOWS_EXE_NAME });
      }
    }
    try {
      verifyPackageFolder(rootDir, version);
    } catch (err) {
      await fsp.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const carryOver = await listForeignEntries(installDir, rootDir);
    const helperLog = logFile || path.join(path.dirname(workDir), 'snotra-update.log');
    const script = path.join(workDir, 'swap.ps1');
    const startedFile = path.join(workDir, 'helper-started');
    const resultFile = path.join(workDir, 'helper-launch.json');
    // Left over from an earlier attempt, either would pass for this one.
    await Promise.all([startedFile, resultFile].map((file) => fsp.rm(file, { force: true })));
    await fsp.writeFile(script, buildWindowsSwapScript({
      pid: pidOf(),
      installDir,
      stagedDir: rootDir,
      stageRoot: stagedDir,
      backupDir,
      workDir,
      logFile: helperLog,
      statusFile: statusFile || path.join(path.dirname(workDir), 'snotra-update-failed.json'),
      startedFile,
      version,
      carryOver,
      exeName,
      previousExeName: WINDOWS_EXE_NAME,
    }), 'utf8');

    // Not from the app's own folder: Windows keeps a process's working
    // directory from being renamed, and the helper would inherit it (#442).
    let launched;
    try {
      const code = await quiet('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-EncodedCommand',
        encodePowerShell(buildWindowsLaunchCommand({
          script, cwd: parentDir, outputFile: helperOutputFile(helperLog), startedFile, resultFile,
        })),
      ], { cwd: parentDir });
      launched = await readLaunchResult(resultFile, code);
    } catch (err) {
      launched = { ok: false, error: err?.message || String(err) };
    }
    if (!launched.ok) {
      await fsp.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
      throw installError('update.error.helperFailed', { error: launched.error });
    }
    return { ok: true, relaunching: true, logFile: helperLog };
  }

  async function installLinuxAppImage({ filePath, target, workDir }) {
    const appImagePath = target.appImagePath;
    await assertWritable(path.dirname(appImagePath), 'update.place.appImageFolder');

    const stagedPath = `${appImagePath}.new-${Date.now()}`;
    await fsp.copyFile(filePath, stagedPath);
    await fsp.chmod(stagedPath, 0o755);

    const script = path.join(workDir, 'relaunch.sh');
    await fsp.writeFile(script, buildLinuxAppImageScript({
      pid: pidOf(), appImagePath, stagedPath, workDir,
    }), { mode: 0o700 });
    launch('/bin/sh', [script]);
    return { ok: true, relaunching: true };
  }

  async function installLinuxDir({ filePath, version, target, workDir }) {
    const installDir = target.installDir;
    const parentDir = path.posix.dirname(installDir);
    await assertWritable(parentDir, 'update.place.installFolder');

    const stamp = Date.now();
    const extractDir = path.join(workDir, `extract-${stamp}`);
    await fsp.mkdir(extractDir, { recursive: true });
    await exec('tar', ['-xzf', filePath, '-C', extractDir]);

    const entries = await fsp.readdir(extractDir, { withFileTypes: true });
    const rootName = entries.find((entry) => entry.isDirectory())?.name || '';
    const extracted = rootName ? path.join(extractDir, rootName) : extractDir;
    const binaryName = findExecutable(extracted, LINUX_BINARY_NAMES);
    if (!binaryName) {
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      throw installError('update.error.archiveMissing', { file: LINUX_BINARY_NAME });
    }
    try {
      verifyPackageFolder(extracted, version);
    } catch (err) {
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    // Vor dem Tausch auf dasselbe Dateisystem bringen — ein `mv` ueber
    // Geraetegrenzen hinweg ist kein Umbenennen mehr, sondern ein Kopieren,
    // und das darf nicht erst im Helferskript auffallen.
    const stagedDir = path.join(parentDir, `.snotra-new-${stamp}`);
    await fsp.rename(extracted, stagedDir);

    const script = path.join(workDir, 'relaunch.sh');
    await fsp.writeFile(script, buildLinuxDirScript({
      pid: pidOf(),
      installDir,
      stagedDir,
      backupDir: path.join(parentDir, `.snotra-old-${stamp}`),
      workDir,
      binaryName,
    }), { mode: 0o700 });
    launch('/bin/sh', [script]);
    return { ok: true, relaunching: true };
  }

  /**
   * Spielt die geladene Datei ein. Wirft nie — ein Fehler kommt als
   * `{ ok: false, error }` zurueck; die laufende Installation ist dann
   * unveraendert.
   *
   * `logFile` and `statusFile` are where the Windows helper reports once this
   * process is gone (#442); they belong outside the app folder and the work
   * folder, which both get replaced or removed.
   */
  async function install({ filePath, version, target, workDir, logFile, statusFile }) {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: createMessage('update.error.fileGone') };
      }
      if (!target || target.canSelfUpdate !== true) {
        return { ok: false, error: target?.reason || createMessage('update.error.selfUpdateImpossible') };
      }
      await fsp.mkdir(workDir, { recursive: true });

      switch (target.kind) {
        case 'macos-bundle': return await installMacos({ filePath, version, target, workDir });
        case 'windows-dir': return await installWindows({ filePath, version, target, workDir, logFile, statusFile });
        case 'linux-appimage': return await installLinuxAppImage({ filePath, version, target, workDir });
        case 'linux-dir': return await installLinuxDir({ filePath, version, target, workDir });
        default: return { ok: false, error: createMessage('update.error.selfUpdateImpossible') };
      }
    } catch (err) {
      // Our own reasons carry a key; what the file system says is quoted.
      return { ok: false, error: err?.userMessage || err?.message || createMessage('update.install.failed') };
    }
  }

  return { install };
}

module.exports = {
  createUpdateInstaller,
  buildMacRelaunchScript,
  buildLinuxAppImageScript,
  buildLinuxDirScript,
  buildWindowsSwapScript,
  buildWindowsLaunchCommand,
  encodePowerShell,
  listForeignEntries,
  macTargetBundlePath,
  helperOutputFile,
  readAsarPackageJson,
  shQuote,
  psQuote,
};
