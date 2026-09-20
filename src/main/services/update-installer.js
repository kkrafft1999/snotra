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

function buildWindowsSwapScript({ pid, installDir, stagedDir, backupDir, workDir, exeName = WINDOWS_EXE_NAME }) {
  return [
    '$ErrorActionPreference =' + " 'Stop'",
    `$procId = ${Number(pid)}`,
    '$deadline = (Get-Date).AddSeconds(120)',
    'while ((Get-Date) -lt $deadline) {',
    '  if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { break }',
    '  Start-Sleep -Milliseconds 250',
    '}',
    // Windows gibt Dateihandles erst kurz nach dem Prozessende frei.
    'Start-Sleep -Milliseconds 1000',
    `$install = ${psQuote(installDir)}`,
    `$staged  = ${psQuote(stagedDir)}`,
    `$backup  = ${psQuote(backupDir)}`,
    `$work    = ${psQuote(workDir)}`,
    'Move-Item -LiteralPath $install -Destination $backup -Force',
    'try {',
    '  Move-Item -LiteralPath $staged -Destination $install -Force',
    '} catch {',
    '  Move-Item -LiteralPath $backup -Destination $install -Force',
    '  throw',
    '}',
    'Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue',
    'Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue',
    `Start-Process -FilePath (Join-Path $install ${psQuote(exeName)})`,
    '',
  ].join('\n');
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
        err.message = `${cmd} fehlgeschlagen: ${String(stderr || err.message).trim()}`;
        reject(err);
        return;
      }
      resolve(String(stdout));
    });
  }));

  const launch = spawnDetached || ((cmd, args) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  });

  async function assertWritable(dir, what) {
    try {
      await fsp.access(dir, fs.constants.W_OK);
    } catch {
      throw new Error(`Keine Schreibrechte für ${what} (${dir}). `
        + 'Installiere die neue Version von Hand oder starte die App mit den nötigen Rechten.');
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
      throw new Error(`Das geladene Programm konnte nicht geprüft werden: ${err.message}`);
    }
    const bundleId = plist?.CFBundleIdentifier;
    const version = plist?.CFBundleShortVersionString;
    if (bundleId !== APP_BUNDLE_ID) {
      throw new Error(`Das geladene Programm ist nicht Snotra AI (Kennung ${bundleId || 'unbekannt'}).`);
    }
    if (expectedVersion && version !== expectedVersion) {
      throw new Error(`Das geladene Programm meldet Version ${version || 'unbekannt'}, erwartet war ${expectedVersion}.`);
    }
  }

  async function installMacos({ filePath, version, target, workDir }) {
    const appBundlePath = target.appBundlePath;
    const parentDir = path.dirname(appBundlePath);
    await assertWritable(parentDir, 'den Programmordner');

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

  async function installWindows({ filePath, target, workDir }) {
    const installDir = target.installDir;
    const parentDir = path.win32.dirname(installDir);
    await assertWritable(parentDir, 'den Installationsordner');

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
        throw new Error(`Im geladenen Archiv fehlt „${WINDOWS_EXE_NAME}".`);
      }
    }

    const script = path.join(workDir, 'swap.ps1');
    await fsp.writeFile(script, buildWindowsSwapScript({
      pid: pidOf(), installDir, stagedDir: rootDir, backupDir, workDir,
    }), 'utf8');
    launch('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', script,
    ]);
    return { ok: true, relaunching: true };
  }

  async function installLinuxAppImage({ filePath, target, workDir }) {
    const appImagePath = target.appImagePath;
    await assertWritable(path.dirname(appImagePath), 'den Ordner des AppImage');

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
    await assertWritable(parentDir, 'den Installationsordner');

    const stamp = Date.now();
    const extractDir = path.join(workDir, `extract-${stamp}`);
    await fsp.mkdir(extractDir, { recursive: true });
    await exec('tar', ['-xzf', filePath, '-C', extractDir]);

    const entries = await fsp.readdir(extractDir, { withFileTypes: true });
    const rootName = entries.find((entry) => entry.isDirectory())?.name || '';
    const extracted = rootName ? path.join(extractDir, rootName) : extractDir;
    if (!fs.existsSync(path.join(extracted, LINUX_BINARY_NAME))) {
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Im geladenen Archiv fehlt „${LINUX_BINARY_NAME}".`);
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
   */
  async function install({ filePath, version, target, workDir }) {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: 'Die geladene Datei ist nicht mehr da.' };
      }
      if (!target || target.canSelfUpdate !== true) {
        return { ok: false, error: target?.reason || 'Selbst-Update ist hier nicht möglich.' };
      }
      await fsp.mkdir(workDir, { recursive: true });

      switch (target.kind) {
        case 'macos-bundle': return await installMacos({ filePath, version, target, workDir });
        case 'windows-dir': return await installWindows({ filePath, version, target, workDir });
        case 'linux-appimage': return await installLinuxAppImage({ filePath, version, target, workDir });
        case 'linux-dir': return await installLinuxDir({ filePath, version, target, workDir });
        default: return { ok: false, error: 'Selbst-Update ist hier nicht möglich.' };
      }
    } catch (err) {
      return { ok: false, error: err?.message || 'Die Installation ist fehlgeschlagen.' };
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
  shQuote,
  psQuote,
};
