// Installation der geladenen Version (Issue #232).
//
// Der echte Tausch laesst sich nicht testen — er ersetzt das laufende
// Programm. Pruefbar ist dafuer alles, was davor entscheidet: welche Befehle
// mit welchen Pfaden laufen, was die Helferskripte enthalten, und vor allem,
// dass ein Fehler die laufende Installation unangetastet laesst.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { translateMessage } = require('../src/shared/i18n');

// Main hands over keys since #353; the German wording is checked through the
// catalogue.
const de = (message) => translateMessage('de', message);

const {
  createUpdateInstaller,
  buildMacRelaunchScript,
  buildLinuxAppImageScript,
  buildLinuxDirScript,
  buildWindowsSwapScript,
  buildWindowsLaunchCommand,
  encodePowerShell,
  listForeignEntries,
  readAsarPackageJson,
  shQuote,
  psQuote,
} = require('../src/main/services/update-installer');

function makeTempDir(prefix = 'snotra-inst-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A real `resources/app.asar` in a package folder, packed by @electron/asar
 * the way the release build packs it (#569).
 */
async function writeAppAsar(packageDir, pkg = { productName: 'Snotra AI', version: '1.13.0' }) {
  const asar = require('@electron/asar');
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-asar-src-'));
  try {
    await fsp.writeFile(path.join(src, 'package.json'), JSON.stringify({ name: 'snotra', ...pkg }));
    await fsp.mkdir(path.join(src, 'src', 'main'), { recursive: true });
    await fsp.writeFile(path.join(src, 'src', 'main', 'index.js'), "'use strict';\n");
    await fsp.mkdir(path.join(packageDir, 'resources'), { recursive: true });
    await asar.createPackage(src, path.join(packageDir, 'resources', 'app.asar'));
  } finally {
    await fsp.rm(src, { recursive: true, force: true });
  }
}

/** The script inside a `-EncodedCommand` call, and the result file it names. */
function decodeLauncher(args) {
  const text = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  return { text, resultFile: text.match(/^\$result {2}= '([^']+)'$/m)[1] };
}

/**
 * Installer, der keine echten Befehle ausfuehrt, aber alle mitschreibt. The
 * Windows launcher reports a started helper unless `onQuiet` says otherwise.
 */
function makeInstaller({ onRun, onQuiet } = {}) {
  const runs = [];
  const launches = [];
  const quiets = [];
  const installer = createUpdateInstaller({
    getPid: () => 4242,
    run: async (cmd, args) => {
      runs.push({ cmd, args });
      if (onRun) return onRun(cmd, args);
      return '';
    },
    spawnDetached: (cmd, args, options) => { launches.push({ cmd, args, options }); },
    runQuiet: async (cmd, args, options) => {
      quiets.push({ cmd, args, options });
      if (onQuiet) return onQuiet(cmd, args, options);
      // PowerShell's UTF-8 comes with a byte order mark.
      await fsp.writeFile(decodeLauncher(args).resultFile, '\uFEFF{"ok":true,"pid":77}');
      return 0;
    },
  });
  return { installer, runs, launches, quiets };
}

test('Pfade werden fuer beide Skriptsprachen sicher eingebettet', () => {
  assert.equal(shQuote("/Apps/Kon's App.app"), `'/Apps/Kon'\\''s App.app'`);
  assert.equal(psQuote("C:\\Kon's App"), "'C:\\Kon''s App'");
});

test('das macOS-Helferskript wartet, raeumt auf und startet neu', () => {
  const script = buildMacRelaunchScript({
    pid: 99,
    appBundlePath: '/Applications/Snotra AI.app',
    backupPath: '/Applications/.snotra-old-1.app',
    workDir: '/tmp/snotra-update',
  });
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /pid=99/);
  assert.match(script, /while kill -0 "\$pid"/);
  assert.match(script, /rm -rf '\/Applications\/\.snotra-old-1\.app'/);
  assert.match(script, /open '\/Applications\/Snotra AI\.app'/);
  // Die Reihenfolge ist der Punkt: erst warten, dann anfassen.
  assert.ok(script.indexOf('kill -0') < script.indexOf('rm -rf'));
  assert.ok(script.indexOf('rm -rf') < script.indexOf('open '));
});

test('das AppImage-Skript ersetzt die Datei und macht sie ausfuehrbar', () => {
  const script = buildLinuxAppImageScript({
    pid: 7,
    appImagePath: '/home/k/Apps/Snotra.AppImage',
    stagedPath: '/home/k/Apps/Snotra.AppImage.new-1',
    workDir: '/tmp/snotra-update',
  });
  assert.match(script, /mv -f '\/home\/k\/Apps\/Snotra\.AppImage\.new-1' '\/home\/k\/Apps\/Snotra\.AppImage'/);
  assert.match(script, /chmod 755 '\/home\/k\/Apps\/Snotra\.AppImage'/);
  assert.match(script, /exec '\/home\/k\/Apps\/Snotra\.AppImage'/);
});

test('das Linux-Ordner-Skript stellt bei einem Fehlschlag die alte Version zurueck', () => {
  const script = buildLinuxDirScript({
    pid: 7,
    installDir: '/home/k/apps/snotra-ai',
    stagedDir: '/home/k/apps/.snotra-new-1',
    backupDir: '/home/k/apps/.snotra-old-1',
    workDir: '/tmp/snotra-update',
  });
  assert.match(script, /mv '\/home\/k\/apps\/snotra-ai' '\/home\/k\/apps\/\.snotra-old-1'/);
  assert.match(script, /if ! mv '\/home\/k\/apps\/\.snotra-new-1' '\/home\/k\/apps\/snotra-ai'; then/);
  // Der Rueckweg muss im Fehlerzweig stehen, sonst steht der Nutzer ohne App da.
  assert.match(script, /\n {2}mv '\/home\/k\/apps\/\.snotra-old-1' '\/home\/k\/apps\/snotra-ai'\n {2}exit 1/);
  assert.match(script, /exec '\/home\/k\/apps\/snotra-ai\/Snotra AI'/);
});

const WINDOWS_SCRIPT_ARGS = Object.freeze({
  pid: 1234,
  installDir: 'C:\\Users\\k\\Snotra AI',
  stagedDir: 'C:\\Users\\k\\.snotra-new-1\\Snotra AI-win32-x64',
  stageRoot: 'C:\\Users\\k\\.snotra-new-1',
  backupDir: 'C:\\Users\\k\\.snotra-old-1',
  workDir: 'C:\\Temp\\snotra-update',
  logFile: 'C:\\Users\\k\\AppData\\Roaming\\Snotra AI\\update-install.log',
  statusFile: 'C:\\Users\\k\\AppData\\Roaming\\Snotra AI\\update-install-failed.json',
  startedFile: 'C:\\Temp\\snotra-update\\helper-started',
  version: '1.13.0',
});

test('das Windows-Skript wartet auf den Prozess und macht den Tausch rueckgaengig', () => {
  const script = buildWindowsSwapScript(WINDOWS_SCRIPT_ARGS);
  assert.match(script, /\$procId {2}= 1234/);
  assert.match(script, /Get-Process -Id \$procId/);
  assert.match(script, /Move-WithRetry \$install \$backup/);
  assert.match(script, /} catch \{\n {4}Move-WithRetry \$backup \$install\n {4}throw/);
  assert.match(script, /\$exe {5}= Join-Path \$install 'Snotra AI\.exe'/);
  assert.match(script, /\nStart-Process -FilePath \$exe\n$/);
});

// #442: The app is usually started from its own folder, and a folder that is
// some process's working directory cannot be renamed on Windows.
test('das Windows-Skript arbeitet ausserhalb des App-Ordners', () => {
  const script = buildWindowsSwapScript(WINDOWS_SCRIPT_ARGS);
  const setLocation = script.indexOf('Set-Location -LiteralPath (Split-Path -Parent $install)');
  assert.ok(setLocation > 0);
  assert.ok(setLocation < script.indexOf('Move-WithRetry $install $backup'));
});

test('das Windows-Skript versucht jeden Zug mehrmals, bevor es aufgibt', () => {
  const script = buildWindowsSwapScript(WINDOWS_SCRIPT_ARGS);
  assert.match(script, /function Move-WithRetry\(\[string\]\$from, \[string\]\$to\)/);
  assert.match(script, /if \(\$i -ge 40\) \{ throw \}/);
  assert.match(script, /Start-Sleep -Milliseconds 500/);
  // Every move of a folder goes through the retry, none around it.
  assert.doesNotMatch(script.replace(/function Move-WithRetry[\s\S]*?\n\}\n/, ''), /Move-Item/);
});

// #654: the launcher holds the app back until the script demonstrably runs.
test('the Windows script reports that it runs before it waits for the app', () => {
  const script = buildWindowsSwapScript(WINDOWS_SCRIPT_ARGS);
  assert.match(script, /\$started = 'C:\\Temp\\snotra-update\\helper-started'/);
  const report = script.indexOf('Set-Content -LiteralPath $started -Value $PID');
  assert.ok(report > 0);
  assert.ok(report < script.indexOf('while ((Get-Date) -lt $deadline)'));
});

const LAUNCH_ARGS = Object.freeze({
  script: 'C:\\Users\\Kon Rad\\AppData\\Local\\Temp\\snotra-update\\swap.ps1',
  cwd: "C:\\Users\\k\\Kon's tools",
  outputFile: 'C:\\Users\\k\\AppData\\Roaming\\Snotra AI\\update-install-output.log',
  startedFile: 'C:\\Temp\\snotra-update\\helper-started',
  resultFile: 'C:\\Temp\\snotra-update\\helper-launch.json',
});

// #654: a child of the app dies with the app; a process the child starts does not.
test('the Windows launcher starts the swap script as a process of its own and waits for its report', () => {
  const text = buildWindowsLaunchCommand(LAUNCH_ARGS);
  assert.ok(text.includes(
    "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass"
      + ' -WindowStyle Hidden -File "C:\\Users\\Kon Rad\\AppData\\Local\\Temp\\snotra-update\\swap.ps1"\'',
  ));
  assert.ok(text.includes(" -WorkingDirectory 'C:\\Users\\k\\Kon''s tools' "));
  assert.match(text, /-RedirectStandardError \$output -PassThru/);
  assert.match(text, /while \(-not \(Test-Path -LiteralPath \$started\)\)/);
  assert.match(text, /Write-Result @\{ ok = \$true; pid = \$p\.Id \}/);
});

test('the Windows launcher reports a helper that ends early or never answers, and stops the latter', () => {
  const text = buildWindowsLaunchCommand({ ...LAUNCH_ARGS, timeoutSeconds: 12 });
  const early = text.slice(text.indexOf('if ($p.HasExited)'), text.indexOf('if ((Get-Date) -gt $deadline)'));
  assert.match(early, /Get-Content -LiteralPath \$output -Raw/);
  assert.match(early, /throw \('the helper ended before it started \(exit code '/);
  const late = text.slice(text.indexOf('if ((Get-Date) -gt $deadline)'));
  assert.match(late, /Stop-Process -Id \$p\.Id -Force/);
  assert.match(late, /within 12 seconds/);
  assert.match(text, /\} catch \{\n {2}Write-Result @\{ ok = \$false; error = \$_\.Exception\.Message\.Trim\(\) \}\n\}/);
});

test('a PowerShell script for -EncodedCommand is UTF-16LE in base64', () => {
  assert.equal(encodePowerShell('ä\n'), Buffer.from([0xe4, 0x00, 0x0a, 0x00]).toString('base64'));
});

test('ein gescheiterter Tausch wird protokolliert, gemeldet und startet die alte Version', () => {
  const script = buildWindowsSwapScript(WINDOWS_SCRIPT_ARGS);
  assert.match(script, /\$log {5}= 'C:\\Users\\k\\AppData\\Roaming\\Snotra AI\\update-install\.log'/);
  assert.match(script, /\$status {2}= 'C:\\Users\\k\\AppData\\Roaming\\Snotra AI\\update-install-failed\.json'/);
  assert.match(script, /\$version = '1\.13\.0'/);
  const failure = script.slice(script.indexOf('} catch {\n  $reason'), script.indexOf('  exit 1'));
  assert.match(failure, /Write-Log \('update failed: ' \+ \$reason\)/);
  assert.match(failure, /ConvertTo-Json \| Set-Content -LiteralPath \$status -Encoding UTF8/);
  assert.match(failure, /Remove-Item -LiteralPath \$stage -Recurse/);
  assert.match(failure, /if \(Test-Path -LiteralPath \$exe\) \{[\s\S]*Start-Process -FilePath \$exe/);
  // The rollback leaves the backup alone: it is the old version again.
  assert.doesNotMatch(failure, /Remove-Item -LiteralPath \$backup/);
});

test('ein gelungener Tausch raeumt auf und loescht eine alte Fehlermeldung', () => {
  const script = buildWindowsSwapScript(WINDOWS_SCRIPT_ARGS);
  const success = script.slice(script.indexOf('$keepBackup = $false'));
  assert.match(success, /Remove-Item -LiteralPath \$status -Force/);
  assert.match(success, /Remove-Item -LiteralPath \$stage -Recurse/);
  assert.match(success, /Remove-Item -LiteralPath \$work -Recurse/);
  assert.match(success, /if \(\$keepBackup\) \{[\s\S]*\} else \{\n {2}Remove-Item -LiteralPath \$backup -Recurse/);
});

test('fremde Eintraege im App-Ordner ziehen in den neuen Ordner mit', () => {
  const none = buildWindowsSwapScript(WINDOWS_SCRIPT_ARGS);
  assert.match(none, /\$carry {3}= @\(\)/);
  const some = buildWindowsSwapScript({
    ...WINDOWS_SCRIPT_ARGS,
    carryOver: ['Snotra AI-win32-x64-1.12.0.zip', "Kon's notes.txt"],
  });
  assert.match(some, /\$carry {3}= @\('Snotra AI-win32-x64-1\.12\.0\.zip', 'Kon''s notes\.txt'\)/);
  assert.match(some, /Move-WithRetry \(Join-Path \$backup \$name\) \(Join-Path \$install \$name\)/);
  // What cannot be carried over keeps the backup instead of vanishing with it.
  assert.match(some, /catch \{ \$keepBackup = \$true;/);
});

test('listForeignEntries findet, was das neue Paket nicht mitbringt, ohne auf Gross-/Kleinschreibung zu achten', async (t) => {
  const dir = makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const installDir = path.join(dir, 'app');
  const packageDir = path.join(dir, 'pkg');
  await fsp.mkdir(path.join(installDir, 'resources'), { recursive: true });
  await fsp.mkdir(path.join(packageDir, 'Resources'), { recursive: true });
  for (const name of ['Snotra AI.exe', 'ffmpeg.dll', 'Snotra AI-win32-x64-1.12.0.zip', 'notes.txt']) {
    await fsp.writeFile(path.join(installDir, name), '');
  }
  for (const name of ['snotra ai.exe', 'FFMPEG.dll', 'vulkan-1.dll']) {
    await fsp.writeFile(path.join(packageDir, name), '');
  }
  assert.deepEqual(
    (await listForeignEntries(installDir, packageDir)).sort(),
    ['Snotra AI-win32-x64-1.12.0.zip', 'notes.txt'],
  );
});

/**
 * A Windows install with POSIX paths: an app folder holding the ZIP it came
 * in, and an Expand-Archive stand-in that unpacks a package with a top-level
 * folder, as electron-forge packs it.
 */
async function prepareWindowsInstall(t) {
  const dir = makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const installDir = path.join(dir, 'tools', 'Snotra AI-win32-x64');
  await fsp.mkdir(installDir, { recursive: true });
  await fsp.writeFile(path.join(installDir, 'Snotra AI.exe'), 'old');
  await fsp.writeFile(path.join(installDir, 'Snotra AI-win32-x64-1.12.0.zip'), 'zip');
  const zip = path.join(dir, 'new.zip');
  await fsp.writeFile(zip, 'zip');
  const onRun = async (cmd, args) => {
    const dest = args[args.length - 1].match(/-DestinationPath '([^']+)'/)[1];
    await fsp.mkdir(path.join(dest, 'Snotra AI-win32-x64'), { recursive: true });
    await fsp.writeFile(path.join(dest, 'Snotra AI-win32-x64', 'Snotra AI.exe'), 'new');
    await writeAppAsar(path.join(dest, 'Snotra AI-win32-x64'));
    return '';
  };
  const options = {
    filePath: zip,
    version: '1.13.0',
    target: { kind: 'windows-dir', canSelfUpdate: true, installDir },
    workDir: path.join(dir, 'work'),
    logFile: path.join(dir, 'userData', 'update-install.log'),
    statusFile: path.join(dir, 'userData', 'update-install-failed.json'),
  };
  return { dir, installDir, onRun, options };
}

test('Windows: der Helfer startet im uebergeordneten Ordner und bekommt Protokoll, Status und Mitbringsel', async (t) => {
  if (process.platform === 'win32') return t.skip('braucht POSIX-Pfade');
  const { dir, onRun, options } = await prepareWindowsInstall(t);
  const { workDir, logFile, statusFile } = options;
  const { installer, runs, launches, quiets } = makeInstaller({ onRun });
  const res = await installer.install(options);

  assert.deepEqual(res, { ok: true, relaunching: true, logFile });
  assert.equal(runs[0].cmd, 'powershell.exe');
  assert.equal(launches.length, 0, 'nothing is spawned detached on Windows');
  assert.equal(quiets.length, 1);
  assert.equal(quiets[0].cmd, 'powershell.exe');
  assert.deepEqual(quiets[0].options, { cwd: path.join(dir, 'tools') });
  const { text } = decodeLauncher(quiets[0].args);
  assert.ok(text.includes(`-File "${path.join(workDir, 'swap.ps1')}"`));
  assert.ok(text.includes(`$output  = ${psQuote(path.join(dir, 'userData', 'update-install-output.log'))}`));
  assert.ok(text.includes(`$started = ${psQuote(path.join(workDir, 'helper-started'))}`));

  const script = await fsp.readFile(path.join(workDir, 'swap.ps1'), 'utf8');
  assert.ok(script.includes(`$log     = ${psQuote(logFile)}`));
  assert.ok(script.includes(`$status  = ${psQuote(statusFile)}`));
  assert.ok(script.includes(`$started = ${psQuote(path.join(workDir, 'helper-started'))}`));
  assert.ok(script.includes("$version = '1.13.0'"));
  assert.ok(script.includes("$carry   = @('Snotra AI-win32-x64-1.12.0.zip')"));
  assert.match(script, /\$staged {2}= '[^']*\.snotra-new-\d+\/Snotra AI-win32-x64'/);
  assert.match(script, /\$stage {3}= '[^']*\.snotra-new-\d+'/);
});

/** After a failed helper start nothing may be left beside the app folder. */
async function assertUntouched(dir, installDir) {
  assert.deepEqual(await fsp.readdir(path.join(dir, 'tools')), ['Snotra AI-win32-x64'], 'the staged folder is gone');
  assert.equal(await fsp.readFile(path.join(installDir, 'Snotra AI.exe'), 'utf8'), 'old');
}

// #654: as long as the app is still running, a helper that did not start can
// be reported instead of leaving the user with a closed app and the old version.
test('Windows: a helper that does not start is reported, and the app stays as it is', async (t) => {
  if (process.platform === 'win32') return t.skip('needs POSIX paths');
  const { dir, installDir, onRun, options } = await prepareWindowsInstall(t);
  const { installer } = makeInstaller({
    onRun,
    onQuiet: async (cmd, args) => {
      await fsp.writeFile(decodeLauncher(args).resultFile, JSON.stringify({
        ok: false, error: 'the helper ended before it started (exit code 1). Running scripts is disabled.',
      }));
      return 0;
    },
  });
  const res = await installer.install(options);

  assert.equal(res.ok, false);
  assert.equal(de(res.error), 'Der Update-Helfer ließ sich nicht starten: the helper ended before it started (exit code 1). Running scripts is disabled.');
  await assertUntouched(dir, installDir);
});

test('Windows: a launcher that leaves no result counts as failed, a stale one from before is not used', async (t) => {
  if (process.platform === 'win32') return t.skip('needs POSIX paths');
  const { dir, installDir, onRun, options } = await prepareWindowsInstall(t);
  await fsp.mkdir(options.workDir, { recursive: true });
  await fsp.writeFile(path.join(options.workDir, 'helper-started'), '1');
  await fsp.writeFile(path.join(options.workDir, 'helper-launch.json'), '{"ok":true,"pid":1}');
  const seen = [];
  const { installer } = makeInstaller({
    onRun,
    onQuiet: async () => {
      seen.push(fs.existsSync(path.join(options.workDir, 'helper-started')),
        fs.existsSync(path.join(options.workDir, 'helper-launch.json')));
      return 1;
    },
  });
  const res = await installer.install(options);

  assert.deepEqual(seen, [false, false], 'both files of the earlier attempt are removed before the launch');
  assert.equal(res.ok, false);
  assert.match(de(res.error), /the launcher ended with exit code 1 and left no result/);
  await assertUntouched(dir, installDir);
});

test('Windows: a launcher that cannot be spawned is reported', async (t) => {
  if (process.platform === 'win32') return t.skip('needs POSIX paths');
  const { dir, installDir, onRun, options } = await prepareWindowsInstall(t);
  const { installer } = makeInstaller({
    onRun,
    onQuiet: async () => { throw new Error('spawn powershell.exe ENOENT'); },
  });
  const res = await installer.install(options);

  assert.equal(res.ok, false);
  assert.match(de(res.error), /nicht starten: spawn powershell\.exe ENOENT$/);
  await assertUntouched(dir, installDir);
});

test('eine PID wird als Zahl eingesetzt, nie als Text', () => {
  const script = buildMacRelaunchScript({
    pid: '99; rm -rf /',
    appBundlePath: '/A/B.app',
    backupPath: '/A/C.app',
    workDir: '/tmp/x',
  });
  assert.match(script, /pid=NaN/);
  assert.doesNotMatch(script, /rm -rf \/\n/);
});

test('ohne geladene Datei passiert nichts', async () => {
  const { installer, runs, launches } = makeInstaller();
  const result = await installer.install({
    filePath: path.join(os.tmpdir(), 'gibt-es-nicht.dmg'),
    version: '1.8.0',
    target: { kind: 'macos-bundle', canSelfUpdate: true, appBundlePath: '/Applications/X.app' },
    workDir: makeTempDir(),
  });
  assert.equal(result.ok, false);
  assert.match(de(result.error), /nicht mehr da/);
  assert.deepEqual(runs, []);
  assert.deepEqual(launches, []);
});

test('ein Ziel ohne Selbst-Update nennt seinen Grund und fasst nichts an', async () => {
  const workDir = makeTempDir();
  const filePath = path.join(workDir, 'snotra.deb');
  await fsp.writeFile(filePath, 'x');
  const { installer, launches } = makeInstaller();

  const result = await installer.install({
    filePath,
    version: '1.8.0',
    target: { kind: 'linux-package', canSelfUpdate: false, reason: 'Braucht Administratorrechte.' },
    workDir,
  });
  assert.deepEqual(result, { ok: false, error: 'Braucht Administratorrechte.' });
  assert.deepEqual(launches, []);
});

test('macOS: mounten, herauskopieren, pruefen, tauschen, neu starten', async (t) => {
  if (process.platform !== 'darwin') return t.skip('nur auf macOS sinnvoll');

  const root = makeTempDir();
  const appsDir = path.join(root, 'Applications');
  const workDir = path.join(root, 'work');
  const appBundlePath = path.join(appsDir, 'Snotra AI.app');
  await fsp.mkdir(appBundlePath, { recursive: true });
  await fsp.writeFile(path.join(appBundlePath, 'alt.txt'), 'alte Version');
  const filePath = path.join(root, 'snotra.dmg');
  await fsp.writeFile(filePath, 'dmg');

  // hdiutil/ditto/plutil werden ersetzt: attach legt ein Schein-Bundle an,
  // ditto kopiert es, plutil meldet die erwarteten Werte.
  const { installer, runs, launches } = makeInstaller({
    onRun: async (cmd, args) => {
      if (cmd.endsWith('hdiutil') && args[0] === 'attach') {
        const mount = args[args.indexOf('-mountpoint') + 1];
        await fsp.mkdir(path.join(mount, 'Snotra AI.app'), { recursive: true });
        return '';
      }
      if (cmd.endsWith('ditto')) {
        await fsp.cp(args[0], args[1], { recursive: true });
        return '';
      }
      if (cmd.endsWith('plutil')) {
        return JSON.stringify({ CFBundleIdentifier: 'dev.snotra-ai.app', CFBundleShortVersionString: '1.8.0' });
      }
      return '';
    },
  });

  const result = await installer.install({
    filePath,
    version: '1.8.0',
    target: { kind: 'macos-bundle', canSelfUpdate: true, appBundlePath },
    workDir,
  });

  assert.deepEqual(result, { ok: true, relaunching: true });
  const commands = runs.map((r) => path.basename(r.cmd));
  assert.deepEqual(commands, ['hdiutil', 'ditto', 'hdiutil', 'plutil', 'xattr']);
  assert.ok(!runs[0].args.includes('-noverify'), 'the DMG checks its own checksums (#569)');
  assert.equal(runs[2].args[0], 'detach', 'das Image muss wieder ausgehaengt werden');

  // Am Ort der alten App steht jetzt die neue, die alte liegt als Sicherung daneben.
  assert.equal(fs.existsSync(path.join(appBundlePath, 'alt.txt')), false);
  const backups = (await fsp.readdir(appsDir)).filter((n) => n.startsWith('.snotra-old-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.existsSync(path.join(appsDir, backups[0], 'alt.txt')), true);

  assert.equal(launches.length, 1);
  assert.equal(launches[0].cmd, '/bin/sh');
  const script = await fsp.readFile(launches[0].args[0], 'utf8');
  assert.match(script, /pid=4242/);
  assert.match(script, /open /);
});

test('macOS: eine fremde Bundle-Kennung stoppt vor dem Tausch', async (t) => {
  if (process.platform !== 'darwin') return t.skip('nur auf macOS sinnvoll');

  const root = makeTempDir();
  const appsDir = path.join(root, 'Applications');
  const workDir = path.join(root, 'work');
  const appBundlePath = path.join(appsDir, 'Snotra AI.app');
  await fsp.mkdir(appBundlePath, { recursive: true });
  await fsp.writeFile(path.join(appBundlePath, 'alt.txt'), 'alte Version');
  const filePath = path.join(root, 'snotra.dmg');
  await fsp.writeFile(filePath, 'dmg');

  const { installer, launches } = makeInstaller({
    onRun: async (cmd, args) => {
      if (cmd.endsWith('hdiutil') && args[0] === 'attach') {
        await fsp.mkdir(path.join(args[args.indexOf('-mountpoint') + 1], 'Fremd.app'), { recursive: true });
        return '';
      }
      if (cmd.endsWith('ditto')) { await fsp.cp(args[0], args[1], { recursive: true }); return ''; }
      if (cmd.endsWith('plutil')) return JSON.stringify({ CFBundleIdentifier: 'com.fremd.app' });
      return '';
    },
  });

  const result = await installer.install({
    filePath,
    version: '1.8.0',
    target: { kind: 'macos-bundle', canSelfUpdate: true, appBundlePath },
    workDir,
  });

  assert.equal(result.ok, false);
  assert.match(de(result.error), /nicht Snotra AI/);
  // A key for the dialog (#353), worded in English when English is on.
  assert.deepEqual(result.error, { key: 'update.error.wrongApp', params: { id: 'com.fremd.app' } });
  assert.equal(translateMessage('en', result.error), 'The downloaded program is not Snotra AI (identifier com.fremd.app).');
  // Entscheidend: die laufende Installation steht unveraendert da.
  assert.equal(fs.existsSync(path.join(appBundlePath, 'alt.txt')), true);
  assert.deepEqual((await fsp.readdir(appsDir)).sort(), ['Snotra AI.app']);
  assert.deepEqual(launches, []);
});

test('macOS: die falsche Version im Paket stoppt ebenfalls vor dem Tausch', async (t) => {
  if (process.platform !== 'darwin') return t.skip('nur auf macOS sinnvoll');

  const root = makeTempDir();
  const appBundlePath = path.join(root, 'Applications', 'Snotra AI.app');
  await fsp.mkdir(appBundlePath, { recursive: true });
  const filePath = path.join(root, 'snotra.dmg');
  await fsp.writeFile(filePath, 'dmg');

  const { installer } = makeInstaller({
    onRun: async (cmd, args) => {
      if (cmd.endsWith('hdiutil') && args[0] === 'attach') {
        await fsp.mkdir(path.join(args[args.indexOf('-mountpoint') + 1], 'Snotra AI.app'), { recursive: true });
        return '';
      }
      if (cmd.endsWith('ditto')) { await fsp.cp(args[0], args[1], { recursive: true }); return ''; }
      if (cmd.endsWith('plutil')) {
        return JSON.stringify({ CFBundleIdentifier: 'dev.snotra-ai.app', CFBundleShortVersionString: '1.2.3' });
      }
      return '';
    },
  });

  const result = await installer.install({
    filePath,
    version: '1.8.0',
    target: { kind: 'macos-bundle', canSelfUpdate: true, appBundlePath },
    workDir: path.join(root, 'work'),
  });
  assert.equal(result.ok, false);
  assert.match(de(result.error), /meldet Version 1\.2\.3, erwartet war 1\.8\.0/);
});

test('Linux-Ordner: ein Archiv ohne Programmdatei wird nicht eingespielt', async (t) => {
  if (process.platform === 'win32') return t.skip('braucht POSIX-Pfade');

  const root = makeTempDir();
  const installDir = path.join(root, 'apps', 'snotra-ai');
  await fsp.mkdir(installDir, { recursive: true });
  const workDir = path.join(root, 'work');
  const filePath = path.join(root, 'snotra.tar.gz');
  await fsp.writeFile(filePath, 'tar');

  const { installer, launches } = makeInstaller({
    onRun: async (cmd, args) => {
      if (cmd === 'tar') {
        // Entpackt einen Ordner ohne die erwartete Programmdatei.
        await fsp.mkdir(path.join(args[args.indexOf('-C') + 1], 'snotra-ai-1.8.0'), { recursive: true });
        return '';
      }
      return '';
    },
  });

  const result = await installer.install({
    filePath,
    version: '1.8.0',
    target: { kind: 'linux-dir', canSelfUpdate: true, installDir },
    workDir,
  });
  assert.equal(result.ok, false);
  assert.match(de(result.error), /fehlt „Snotra AI“/);
  assert.deepEqual(launches, [], 'ohne gepruefte Dateien wird kein Helfer gestartet');
});

test('the minimal test archive is a real asar, and the reader reads it (#569)', async (t) => {
  const asar = require('@electron/asar');
  const { writeMinimalAsar } = require('./helpers/asar.js');
  const dir = makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.asar');
  writeMinimalAsar(file, { 'LICENSE': 'Apache-2.0', 'package.json': '{"productName":"Snotra AI","version":"3.0.1"}' });
  // @electron/asar lists with the platform's separator.
  const listed = asar.listPackage(file, { isPack: false }).map((entry) => entry.replace(/\\/g, '/')).sort();
  assert.deepEqual(listed, ['/LICENSE', '/package.json']);
  assert.equal(asar.extractFile(file, 'package.json').toString(), '{"productName":"Snotra AI","version":"3.0.1"}');
  assert.equal(readAsarPackageJson(file).version, '3.0.1');
});

test('readAsarPackageJson reads package.json from a packed archive (#569)', async (t) => {
  const dir = makeTempDir();
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await writeAppAsar(dir, { productName: 'Snotra AI', version: '2.4.6' });
  const pkg = readAsarPackageJson(path.join(dir, 'resources', 'app.asar'));
  assert.equal(pkg.productName, 'Snotra AI');
  assert.equal(pkg.version, '2.4.6');

  const garbage = path.join(dir, 'garbage.asar');
  await fsp.writeFile(garbage, Buffer.alloc(64, 0xff));
  assert.throws(() => readAsarPackageJson(garbage), /implausible archive header/);
  const short = path.join(dir, 'short.asar');
  await fsp.writeFile(short, Buffer.alloc(4));
  assert.throws(() => readAsarPackageJson(short), /truncated archive/);
});

// #569: a package that is not the announced version would be installed, found
// "newer" again after the restart and offered for ever.
for (const [label, pkg, pattern] of [
  ['another version', { productName: 'Snotra AI', version: '1.12.9' }, /meldet Version 1\.12\.9, erwartet war 1\.13\.0/],
  ['another app', { productName: 'Something Else', version: '1.13.0' }, /nicht Snotra AI \(Kennung Something Else\)/],
]) {
  test(`Windows: a package with ${label} stops before the swap`, async (t) => {
    if (process.platform === 'win32') return t.skip('braucht POSIX-Pfade');
    const dir = makeTempDir();
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const installDir = path.join(dir, 'tools', 'Snotra AI-win32-x64');
    await fsp.mkdir(installDir, { recursive: true });
    await fsp.writeFile(path.join(installDir, 'Snotra AI.exe'), 'old');
    const zip = path.join(dir, 'new.zip');
    await fsp.writeFile(zip, 'zip');

    const { installer, launches } = makeInstaller({
      onRun: async (cmd, args) => {
        const dest = args[args.length - 1].match(/-DestinationPath '([^']+)'/)[1];
        await fsp.mkdir(dest, { recursive: true });
        await fsp.writeFile(path.join(dest, 'Snotra AI.exe'), 'new');
        await writeAppAsar(dest, pkg);
        return '';
      },
    });
    const res = await installer.install({
      filePath: zip,
      version: '1.13.0',
      target: { kind: 'windows-dir', canSelfUpdate: true, installDir },
      workDir: path.join(dir, 'work'),
    });

    assert.equal(res.ok, false);
    assert.match(de(res.error), pattern);
    assert.deepEqual(launches, [], 'no helper for an unverified package');
    const left = (await fsp.readdir(path.join(dir, 'tools'))).filter((n) => n.startsWith('.snotra-new-'));
    assert.deepEqual(left, [], 'the unpacked package is removed again');
  });
}

test('Linux-Ordner: a package with another version is not swapped in (#569)', async (t) => {
  if (process.platform === 'win32') return t.skip('braucht POSIX-Pfade');
  const root = makeTempDir();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const installDir = path.join(root, 'apps', 'snotra-ai');
  await fsp.mkdir(installDir, { recursive: true });
  const filePath = path.join(root, 'snotra.tar.gz');
  await fsp.writeFile(filePath, 'tar');

  const { installer, launches } = makeInstaller({
    onRun: async (cmd, args) => {
      if (cmd !== 'tar') return '';
      const pkgDir = path.join(args[args.indexOf('-C') + 1], 'snotra-ai-1.8.0');
      await fsp.mkdir(pkgDir, { recursive: true });
      await fsp.writeFile(path.join(pkgDir, 'Snotra AI'), 'bin');
      await writeAppAsar(pkgDir, { productName: 'Snotra AI', version: '1.7.9' });
      return '';
    },
  });
  const result = await installer.install({
    filePath,
    version: '1.8.0',
    target: { kind: 'linux-dir', canSelfUpdate: true, installDir },
    workDir: path.join(root, 'work'),
  });
  assert.equal(result.ok, false);
  assert.match(de(result.error), /meldet Version 1\.7\.9, erwartet war 1\.8\.0/);
  assert.deepEqual(launches, []);
  assert.deepEqual((await fsp.readdir(path.join(root, 'apps'))).filter((n) => n.startsWith('.snotra-')), []);
});

test('Linux-AppImage: die neue Datei wird danebengelegt, nicht sofort getauscht', async (t) => {
  if (process.platform === 'win32') return t.skip('braucht POSIX-Rechte');

  const root = makeTempDir();
  const appImagePath = path.join(root, 'Snotra.AppImage');
  await fsp.writeFile(appImagePath, 'alt');
  const workDir = path.join(root, 'work');
  const filePath = path.join(root, 'neu.AppImage');
  await fsp.writeFile(filePath, 'neu');

  const { installer, launches } = makeInstaller();
  const result = await installer.install({
    filePath,
    version: '1.8.0',
    target: { kind: 'linux-appimage', canSelfUpdate: true, appImagePath },
    workDir,
  });

  assert.deepEqual(result, { ok: true, relaunching: true });
  assert.equal(await fsp.readFile(appImagePath, 'utf8'), 'alt', 'erst das Helferskript tauscht');
  const staged = (await fsp.readdir(root)).find((n) => n.startsWith('Snotra.AppImage.new-'));
  assert.ok(staged, 'die neue Datei liegt bereit');
  assert.equal((await fsp.stat(path.join(root, staged))).mode & 0o777, 0o755);
  assert.equal(launches.length, 1);
});

test('fehlende Schreibrechte werden erklaert, nicht durchgereicht', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    return t.skip('braucht POSIX-Rechte und einen Nicht-root-Nutzer');
  }
  const root = makeTempDir();
  const appsDir = path.join(root, 'Applications');
  const appBundlePath = path.join(appsDir, 'Snotra AI.app');
  await fsp.mkdir(appBundlePath, { recursive: true });
  const filePath = path.join(root, 'snotra.dmg');
  await fsp.writeFile(filePath, 'dmg');
  await fsp.chmod(appsDir, 0o500);
  t.after(() => fsp.chmod(appsDir, 0o700).catch(() => {}));

  const { installer, runs } = makeInstaller();
  const result = await installer.install({
    filePath,
    version: '1.8.0',
    target: { kind: 'macos-bundle', canSelfUpdate: true, appBundlePath },
    workDir: path.join(root, 'work'),
  });

  assert.equal(result.ok, false);
  assert.match(de(result.error), /Keine Schreibrechte/);
  assert.deepEqual(runs, [], 'ohne Schreibrecht wird gar nicht erst gemountet');
});
