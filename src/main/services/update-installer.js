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

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile, spawn } = require('child_process');

const { APP_NAME, APP_BUNDLE_ID } = require('../app-identity');
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
 */
function buildWindowsSwapScript({
  pid, installDir, stagedDir, stageRoot = stagedDir, backupDir, workDir,
  logFile, statusFile, version = '', carryOver = [], exeName = WINDOWS_EXE_NAME,
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
    `$version = ${psQuote(version)}`,
    `$carry   = ${carry}`,
    `$exe     = Join-Path $install ${psQuote(exeName)}`,
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
    '  if (Test-Path -LiteralPath $exe) {',
    "    Write-Log 'starting the previous version again'",
    '    Start-Process -FilePath $exe',
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
 * @param {function} [deps.spawnDetached]  Test-Haken fuer den Helferstart.
 */
function createUpdateInstaller({ getPid, run, spawnDetached } = {}) {
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

  // `outputFile` catches what the helper prints — above all what PowerShell
  // says when the script cannot even start. The helper outlives this process,
  // so a file is the only place that can still hear it (#442).
  const launch = spawnDetached || ((cmd, args, { outputFile, ...options } = {}) => {
    let fd = null;
    if (outputFile) {
      try { fd = fs.openSync(outputFile, 'w'); } catch { fd = null; }
    }
    const stdio = fd === null ? 'ignore' : ['ignore', fd, fd];
    // Not detached on Windows: there it means DETACHED_PROCESS, a process
    // without any console, and powershell.exe ends at once without a word.
    // A child outlives its parent on Windows anyway; attached, it gets a
    // console of its own, which `windowsHide` keeps out of sight (#442).
    const detached = process.platform !== 'win32';
    try {
      const child = spawn(cmd, args, { detached, stdio, windowsHide: true, ...options });
      child.unref();
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  });

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

  async function installMacos({ filePath, version, target, workDir }) {
    const appBundlePath = target.appBundlePath;
    const parentDir = path.dirname(appBundlePath);
    await assertWritable(parentDir, 'update.place.appFolder');

    const stamp = Date.now();
    const mountPoint = path.join(workDir, `mnt-${stamp}`);
    const stagedPath = path.join(parentDir, `.snotra-new-${stamp}.app`);
    const backupPath = path.join(parentDir, `.snotra-old-${stamp}.app`);

    await fsp.mkdir(mountPoint, { recursive: true });
    await exec('/usr/bin/hdiutil', [
      'attach', filePath, '-nobrowse', '-readonly', '-noverify', '-mountpoint', mountPoint,
    ]);
    try {
      const entries = await fsp.readdir(mountPoint);
      const bundleName = entries.find((name) => name.endsWith('.app')) || MAC_BUNDLE_NAME;
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
      await fsp.rename(stagedPath, appBundlePath);
    } catch (err) {
      await fsp.rename(backupPath, appBundlePath).catch(() => {});
      await fsp.rm(stagedPath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const script = path.join(workDir, 'relaunch.sh');
    await fsp.writeFile(script, buildMacRelaunchScript({
      pid: pidOf(), appBundlePath, backupPath, workDir,
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
    if (!fs.existsSync(path.join(rootDir, WINDOWS_EXE_NAME))) {
      const entries = await fsp.readdir(stagedDir, { withFileTypes: true });
      const single = entries.length === 1 && entries[0].isDirectory() ? entries[0].name : '';
      if (single && fs.existsSync(path.join(stagedDir, single, WINDOWS_EXE_NAME))) {
        rootDir = path.join(stagedDir, single);
      } else {
        await fsp.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
        throw installError('update.error.archiveMissing', { file: WINDOWS_EXE_NAME });
      }
    }

    const carryOver = await listForeignEntries(installDir, rootDir);
    const helperLog = logFile || path.join(path.dirname(workDir), 'snotra-update.log');
    const script = path.join(workDir, 'swap.ps1');
    await fsp.writeFile(script, buildWindowsSwapScript({
      pid: pidOf(),
      installDir,
      stagedDir: rootDir,
      stageRoot: stagedDir,
      backupDir,
      workDir,
      logFile: helperLog,
      statusFile: statusFile || path.join(path.dirname(workDir), 'snotra-update-failed.json'),
      version,
      carryOver,
    }), 'utf8');
    // Not from the app's own folder: Windows keeps a process's working
    // directory from being renamed, and the helper would inherit it (#442).
    launch('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', script,
    ], { cwd: parentDir, outputFile: helperOutputFile(helperLog) });
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

  async function installLinuxDir({ filePath, target, workDir }) {
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
    if (!fs.existsSync(path.join(extracted, LINUX_BINARY_NAME))) {
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      throw installError('update.error.archiveMissing', { file: LINUX_BINARY_NAME });
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
  listForeignEntries,
  helperOutputFile,
  shQuote,
  psQuote,
};
