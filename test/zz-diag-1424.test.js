'use strict';

// TEMPORARY verification for #1424 — removed before the fix is merged.
// Unpacks the released v1.32.1 ZIP on the runner: with the new command under
// the inherited PSModulePath, and with the old Expand-Archive under the
// machine's PSModulePath, which is what an app started from Explorer sees.

const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { windowsExtractCommand, readAsarPackageJson } = require('../src/main/services/update-installer');

const onWindows = process.platform === 'win32';
const EXE = 'Snotra Agent.exe';

function ps(command, env = process.env) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', env });
  return `exit=${r.status}\n--stdout--\n${(r.stdout || '').trim()}\n--stderr--\n${(r.stderr || '').trim()}`;
}

function summary(dir) {
  if (!fs.existsSync(dir)) return '(no folder)';
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else files += 1;
    }
  };
  walk(dir);
  let pkg = '';
  try { pkg = JSON.stringify(readAsarPackageJson(path.join(dir, 'resources', 'app.asar'))).slice(0, 120); } catch (e) { pkg = `asar: ${e.message}`; }
  return `files=${files} exe=${fs.existsSync(path.join(dir, EXE))} ${pkg}`;
}

test('verify #1424 on the released v1.32.1 ZIP', { skip: !onWindows, timeout: 110_000 }, () => {
  const report = [];
  report.push(`process PSModulePath = ${process.env.PSModulePath}`);
  report.push(`-- machine/user PSModulePath:\n${ps("'machine=' + [Environment]::GetEnvironmentVariable('PSModulePath','Machine'); 'user=' + [Environment]::GetEnvironmentVariable('PSModulePath','User')")}`);
  report.push(`-- parent shell of this job: ${process.env.PSExecutionPolicyPreference || ''} POWERSHELL_DISTRIBUTION_CHANNEL=${process.env.POWERSHELL_DISTRIBUTION_CHANNEL || ''}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-1424-'));
  const zip = path.join(dir, 'Snotra-Agent-1.32.1-win-x64.zip');
  report.push(ps(`$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/kkrafft1999/snotra/releases/download/v1.32.1/Snotra-Agent-1.32.1-win-x64.zip' -OutFile '${zip}'; (Get-Item '${zip}').Length`));

  const a = path.join(dir, "Kon's tools", '.snotra-new-1');
  fs.mkdirSync(path.dirname(a), { recursive: true });
  const t0 = Date.now();
  report.push(`\n===== A: new command, inherited PSModulePath\n${ps(windowsExtractCommand(zip, a))}\n${summary(a)} in ${Date.now() - t0} ms`);

  const machine = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('PSModulePath','Machine')"], { encoding: 'utf8' }).stdout.trim();
  const b = path.join(dir, '.snotra-new-2');
  const t1 = Date.now();
  report.push(`\n===== B: old Expand-Archive, machine PSModulePath (Explorer start)\n${ps(`(Get-Command Expand-Archive).Module.Version.ToString(); Expand-Archive -LiteralPath '${zip}' -DestinationPath '${b}' -Force`, { ...process.env, PSModulePath: machine })}\n${summary(b)} in ${Date.now() - t1} ms`);

  const c = path.join(dir, '.snotra-new-3');
  report.push(`\n===== C: new command into a folder that exists with a file in it\n`);
  fs.mkdirSync(c);
  fs.writeFileSync(path.join(c, EXE), 'there already');
  report.push(ps(windowsExtractCommand(zip, c)));

  throw new Error(`VERIFY-1424 REPORT\n${report.join('\n')}\nEND VERIFY-1424`);
});
