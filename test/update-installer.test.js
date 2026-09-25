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
  shQuote,
  psQuote,
} = require('../src/main/services/update-installer');

function makeTempDir(prefix = 'snotra-inst-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Installer, der keine echten Befehle ausfuehrt, aber alle mitschreibt. */
function makeInstaller({ onRun } = {}) {
  const runs = [];
  const launches = [];
  const installer = createUpdateInstaller({
    getPid: () => 4242,
    run: async (cmd, args) => {
      runs.push({ cmd, args });
      if (onRun) return onRun(cmd, args);
      return '';
    },
    spawnDetached: (cmd, args) => { launches.push({ cmd, args }); },
  });
  return { installer, runs, launches };
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

test('das Windows-Skript wartet auf den Prozess und macht den Tausch rueckgaengig', () => {
  const script = buildWindowsSwapScript({
    pid: 1234,
    installDir: 'C:\\Users\\k\\Snotra AI',
    stagedDir: 'C:\\Users\\k\\.snotra-new-1',
    backupDir: 'C:\\Users\\k\\.snotra-old-1',
    workDir: 'C:\\Temp\\snotra-update',
  });
  assert.match(script, /\$procId = 1234/);
  assert.match(script, /Get-Process -Id \$procId/);
  assert.match(script, /Move-Item -LiteralPath \$install -Destination \$backup -Force/);
  assert.match(script, /} catch \{\n {2}Move-Item -LiteralPath \$backup -Destination \$install -Force\n {2}throw/);
  assert.match(script, /Start-Process -FilePath \(Join-Path \$install 'Snotra AI\.exe'\)/);
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
