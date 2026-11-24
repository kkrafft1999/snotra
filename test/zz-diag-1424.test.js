'use strict';

// TEMPORARY diagnostics for #1424 — removed before the fix is merged.
// Replays the release-ZIP fixture of update-installer-windows.test.js step by
// step on the runner and reports what each step leaves behind.

const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeMinimalAsar } = require('./helpers/asar.js');

const onWindows = process.platform === 'win32';
const EXE = 'Snotra Agent.exe';
const FOLDER = 'Snotra Agent-win32-x64';

function ps(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' });
  return `exit=${r.status} signal=${r.signal}\n--stdout--\n${(r.stdout || '').trim()}\n--stderr--\n${(r.stderr || '').trim()}`;
}

function tree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      out.push(`${rel || '.'}: ${err.code}`);
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(p, r);
      } else {
        let size = '?';
        try { size = fs.statSync(p).size; } catch (err) { size = err.code; }
        out.push(`${r} (${size})`);
      }
    }
  };
  walk(root, '');
  return out.join('\n') || '(empty)';
}

const LIST_ZIP = (zip) => `Add-Type -AssemblyName System.IO.Compression.FileSystem; `
  + `$z = [System.IO.Compression.ZipFile]::OpenRead('${zip}'); `
  + `$z.Entries | ForEach-Object { $_.FullName + ' (' + $_.Length + ')' }; $z.Dispose()`;

function scenario(report, label, baseDir, exeBytes) {
  report.push(`\n===== ${label}: base ${baseDir}`);
  const dir = fs.mkdtempSync(path.join(baseDir, 'diag-1424-'));
  const packageDir = path.join(dir, 'package', FOLDER);
  fs.mkdirSync(path.join(packageDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, EXE), exeBytes);
  fs.writeFileSync(path.join(packageDir, 'version'), 'new');
  fs.writeFileSync(path.join(packageDir, 'stand-in.txt'), 'confirm\r\nx');
  writeMinimalAsar(path.join(packageDir, 'resources', 'app.asar'), {
    'package.json': JSON.stringify({ productName: 'Snotra Agent', version: '1.13.0' }),
  });
  report.push(`realpath(dir) = ${fs.realpathSync.native(dir)}`);
  report.push(`-- package tree before zip:\n${tree(path.join(dir, 'package'))}`);
  const zip = path.join(dir, `${FOLDER}-1.13.0.zip`);
  report.push(`-- Compress-Archive:\n${ps(`Compress-Archive -LiteralPath '${packageDir}' -DestinationPath '${zip}'`)}`);
  report.push(`-- zip entries:\n${ps(LIST_ZIP(zip))}`);
  const staged = path.join(dir, 'my tools', '.snotra-new-1');
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  report.push(`-- Expand-Archive:\n${ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${staged}' -Force`)}`);
  report.push(`-- staged tree right after:\n${tree(staged)}`);
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3000)']);
  report.push(`-- staged tree 3 s later:\n${tree(staged)}`);
  report.push(`-- package tree 3 s later:\n${tree(path.join(dir, 'package'))}`);
  const tarDir = path.join(dir, 'tar-out');
  fs.mkdirSync(tarDir);
  const t = spawnSync('tar.exe', ['-xf', zip, '-C', tarDir], { encoding: 'utf8' });
  report.push(`-- tar.exe -xf: exit=${t.status} ${t.stderr}\n${tree(tarDir)}`);
}

test('diag #1424: what the release-ZIP fixture leaves on this runner', { skip: !onWindows, timeout: 110_000 }, () => {
  const report = [];
  report.push(`os.tmpdir() = ${os.tmpdir()}`);
  try { report.push(`realpath(tmpdir) = ${fs.realpathSync.native(os.tmpdir())}`); } catch (e) { report.push(`realpath failed ${e.code}`); }
  report.push(`cwd = ${process.cwd()}`);
  report.push(`-- environment:\n${ps([
    '$PSVersionTable.PSVersion.ToString()',
    '[Environment]::OSVersion.VersionString',
    'Get-Module -ListAvailable Microsoft.PowerShell.Archive | ForEach-Object { $_.Version.ToString() + " " + $_.ModuleBase }',
    '(Get-Command Expand-Archive).Module.Version.ToString()',
    'Get-Volume -DriveLetter C,D | ForEach-Object { $_.DriveLetter + ": " + $_.FileSystemType }',
    'try { $s = Get-MpComputerStatus; "Defender RTP=" + $s.RealTimeProtectionEnabled + " AM=" + $s.AMServiceEnabled + " IOAV=" + $s.IoavProtectionEnabled } catch { "Get-MpComputerStatus failed: " + $_ }',
    'try { Get-MpPreference | Select-Object -ExpandProperty ExclusionPath } catch { "no prefs" }',
    'try { Get-CimInstance -Namespace root/Microsoft/Windows/CI -ClassName MSFT_MpPreference -ErrorAction Stop | Out-Null } catch { }',
    'try { (Get-ItemProperty "HKLM:/SYSTEM/CurrentControlSet/Control/CI/Policy" -ErrorAction Stop).VerifiedAndReputablePolicyState } catch { "no SAC key" }',
  ].join('; '))}`);

  const realExe = path.join(os.tmpdir(), `diag-1424-exe-${process.pid}`);
  fs.mkdirSync(realExe, { recursive: true });
  const src = path.join(realExe, 'a.cs');
  fs.writeFileSync(src, 'static class A { static int Main() { return 0; } }');
  const exePath = path.join(realExe, 'a.exe');
  report.push(`-- compile:\n${ps(`Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${src}') -OutputAssembly '${exePath}' -OutputType ConsoleApplication -IgnoreWarnings`)}`);
  const exeBytes = fs.existsSync(exePath) ? fs.readFileSync(exePath) : Buffer.from('MZ');

  scenario(report, 'real exe in tmpdir', os.tmpdir(), exeBytes);
  scenario(report, 'text as exe in tmpdir', os.tmpdir(), Buffer.from('not a program'));
  const work = path.join(process.cwd(), 'out', 'diag-1424');
  fs.mkdirSync(work, { recursive: true });
  scenario(report, 'real exe on D: workspace', work, exeBytes);

  // The same package zipped by .NET directly, the way cross-zip does it.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-1424-net-'));
    const packageDir = path.join(dir, 'package', FOLDER);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, EXE), exeBytes);
    fs.writeFileSync(path.join(packageDir, 'version'), 'new');
    const zip = path.join(dir, 'net.zip');
    report.push(`\n===== .NET CreateFromDirectory + Expand-Archive`);
    report.push(ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${path.join(dir, 'package')}', '${zip}')`));
    report.push(`-- zip entries:\n${ps(LIST_ZIP(zip))}`);
    const staged = path.join(dir, '.snotra-new-2');
    report.push(ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${staged}' -Force`));
    report.push(`-- staged tree:\n${tree(staged)}`);
  }

  // The released v1.32.1 ZIP, as a released app would download it.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-1424-rel-'));
    const zip = path.join(dir, 'Snotra-Agent-1.32.1-win-x64.zip');
    report.push(`\n===== released v1.32.1 ZIP`);
    report.push(ps(`$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/kkrafft1999/snotra/releases/download/v1.32.1/Snotra-Agent-1.32.1-win-x64.zip' -OutFile '${zip}'; (Get-Item '${zip}').Length`));
    report.push(`-- first zip entries:\n${ps(LIST_ZIP(zip) + ' | Select-Object -First 8')}`);
    const staged = path.join(dir, '.snotra-new-3');
    report.push(ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${staged}' -Force`));
    const top = fs.existsSync(staged) ? fs.readdirSync(staged) : [];
    report.push(`-- staged top level: ${top.join(', ') || '(none)'}`);
    report.push(`-- exe there: ${fs.existsSync(path.join(staged, EXE))}`);
  }

  report.push(`-- Defender detections:\n${ps('try { Get-MpThreatDetection | Select-Object -Last 10 | ForEach-Object { $_.InitialDetectionTime.ToString("o") + " " + ($_.Resources -join ",") + " action=" + $_.ActionSuccess } } catch { "n/a: " + $_ }')}`);
  report.push(`-- Defender threats:\n${ps('try { Get-MpThreat | ForEach-Object { $_.ThreatName + " " + ($_.Resources -join ",") } } catch { "n/a: " + $_ }')}`);
  report.push(`-- Defender events:\n${ps('try { Get-WinEvent -LogName "Microsoft-Windows-Windows Defender/Operational" -MaxEvents 15 -ErrorAction Stop | Where-Object { $_.TimeCreated -gt (Get-Date).AddMinutes(-30) } | ForEach-Object { $_.TimeCreated.ToString("o") + " " + $_.Id + " " + ($_.Message -split "`n")[0..6] -join " | " } } catch { "n/a: " + $_ }')}`);

  throw new Error(`DIAG-1424 REPORT\n${report.join('\n')}\nEND DIAG-1424`);
});
