'use strict';

// Replaces the installed app with the downloaded one and starts it again.
//
// The swap itself cannot happen in the running process on Windows (the
// running .exe is locked) or Linux (the AppImage is mounted inside its own
// process); macOS renames the bundles in-process before it quits. The pattern
// is the same everywhere: the new version is unpacked and verified **next to**
// the old one, then a detached helper script takes over — wait until this app
// has quit, rename, start, report a failure to the next start, put the old
// version back and start it. The helper also waits until the new version
// confirms that it runs before it deletes the backup (#1003, #1067).
//
// Everything that can go wrong before the restart goes wrong before it:
// missing write access, a broken archive, the wrong version in the package.
// After the `rename` the only way left is back to the saved old version.
//
// What is verified, per platform (#569): the download's SHA-256 against the
// release everywhere (update-download.js); on macOS the DMG's own checksum,
// the bundle identifier and the version in Info.plist; in a Windows or Linux
// folder the product name and the version in the package's `package.json`.
// The AppImage is a single file and is checked by its checksum only.

const fs = require('fs');
const fsp = require('fs/promises');
// A package carries `resources/app.asar`, which Electron's `fs` takes for a
// folder: reading it and removing a package go through the unpatched module.
const { rawFs, removeTree } = require('./raw-fs');
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

/** How long a POSIX helper waits for this app to quit, and for the new version to start. */
const POSIX_QUIT_SECONDS = 120;
const POSIX_START_SECONDS = 120;

/** `s` as a literal inside an extended regular expression, for `pkill -f`. */
function ereEscape(value) {
  return String(value).replace(/[.[\]()*+?{}|^$\\]/g, '\\$&');
}

/**
 * macOS/Linux: what every helper script shares (#1003).
 *
 * The contract is the one the Windows helper has had since #442: every step
 * goes to `logFile`; a failure leaves `statusFile` for the next start, which
 * reports it; the previous version is put back and started again. On top of
 * that the backup only goes once the new version has *started*: before
 * launching it, the helper writes `pendingFile`, and the new version removes
 * that file once its window is open (`confirmInstallStarted` in
 * update-service.js). If the file is still there when the new process has
 * ended, or after `startSeconds`, the update counts as failed.
 *
 * - `wait_for_quit` waits for this process; `kill -0` only asks whether the
 *   PID exists, it ends nothing.
 * - `record STAGE REASON` writes the status file: `swap` when the new version
 *   could not be put in place, `start` when it was but did not start.
 * - `await_start PID` waits for the confirmation while PID runs, and leaves
 *   the reason in `$reason` when it gives up. The shell reaps a background
 *   child while it waits on `sleep`, so `kill -0` does not see a zombie.
 * - `stop_new PID` ends a new version that did not confirm, gently first.
 */
function buildPosixPrelude({
  pid, version = '', logFile, statusFile, pendingFile,
  quitSeconds = POSIX_QUIT_SECONDS, startSeconds = POSIX_START_SECONDS,
}) {
  const quitTicks = Math.max(1, Math.round(Number(quitSeconds) * 5));
  const startTicks = Math.max(1, Math.round(Number(startSeconds) * 5));
  return [
    '#!/bin/sh',
    `pid=${Number(pid)}`,
    `version=${shQuote(version)}`,
    `logfile=${shQuote(logFile)}`,
    `status=${shQuote(statusFile)}`,
    `pending=${shQuote(pendingFile)}`,
    '',
    'now() { date -u +%Y-%m-%dT%H:%M:%SZ; }',
    String.raw`log() { printf '%s %s\n' "$(now)" "$*" >>"$logfile" 2>/dev/null || :; }`,
    // The content of a JSON string: control characters out, \ and " escaped.
    String.raw`json() { printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }`,
    '',
    'record() {',
    '  log "update failed: $2"',
    String.raw`  entry=$(printf '{"version":"%s","stage":"%s","error":"%s","log":"%s","at":"%s"}' "$(json "$version")" "$1" "$(json "$2")" "$(json "$logfile")" "$(now)")`,
    String.raw`  printf '%s\n' "$entry" >"$status.tmp" 2>/dev/null && mv -f "$status.tmp" "$status" 2>/dev/null || :`,
    '  rm -f "$pending"',
    '}',
    '',
    'wait_for_quit() {',
    '  log "update to $version: waiting for process $pid"',
    '  i=0',
    '  while kill -0 "$pid" 2>/dev/null; do',
    `    [ "$i" -ge ${quitTicks} ] && return 1`,
    '    sleep 0.2',
    '    i=$((i+1))',
    '  done',
    '  return 0',
    '}',
    '',
    'announce_start() {',
    String.raw`  printf '{"version":"%s"}\n' "$(json "$version")" >"$pending" 2>/dev/null || log "could not write $pending"`,
    '  log "starting the new version"',
    '}',
    '',
    'await_start() {',
    '  i=0',
    '  while [ -e "$pending" ]; do',
    '    if ! kill -0 "$1" 2>/dev/null; then',
    '      [ -e "$pending" ] || return 0',
    '      wait "$1"',
    '      reason="the new version ended before it had started (exit code $?)"',
    '      return 1',
    '    fi',
    `    if [ "$i" -ge ${startTicks} ]; then`,
    `      reason='the new version did not start within ${Number(startSeconds)} seconds'`,
    '      return 1',
    '    fi',
    '    sleep 0.2',
    '    i=$((i+1))',
    '  done',
    '  return 0',
    '}',
    '',
    'confirmed() {',
    '  rm -f "$status"',
    '  log "updated to $version"',
    '}',
    '',
  ].join('\n');
}

/** `reason` for an app that is still running when the helper stops waiting. */
function quitTimeoutReason(quitSeconds = POSIX_QUIT_SECONDS) {
  return `the app did not quit within ${Number(quitSeconds)} seconds`;
}

/**
 * macOS. This process has already renamed the old bundle to `backupPath` and
 * the new one to `targetBundlePath` before it quit (`installMacos`); the
 * helper starts the new bundle and, if it does not confirm, puts the old one
 * back at `appBundlePath` and opens that.
 *
 * `open -W -n` runs in the background as the stand-in for the new process: it
 * ends when the app ends. The app itself is no child of the helper, so one that
 * hangs is found by its path with `pkill -f`.
 */
function buildMacRelaunchScript({
  pid, appBundlePath, targetBundlePath = appBundlePath, backupPath, workDir,
  version, logFile, statusFile, pendingFile, quitSeconds, startSeconds,
}) {
  const processPattern = ereEscape(`${targetBundlePath}/Contents/`);
  return [
    buildPosixPrelude({ pid, version, logFile, statusFile, pendingFile, quitSeconds, startSeconds }),
    `app=${shQuote(appBundlePath)}`,
    `target=${shQuote(targetBundlePath)}`,
    `backup=${shQuote(backupPath)}`,
    `work=${shQuote(workDir)}`,
    `pattern=${shQuote(processPattern)}`,
    '',
    'stop_new() {',
    '  kill "$1" 2>/dev/null',
    '  pkill -f "$pattern" 2>/dev/null || return 0',
    '  i=0',
    '  while pgrep -f "$pattern" >/dev/null 2>&1 && [ "$i" -lt 25 ]; do sleep 0.2; i=$((i+1)); done',
    '  pkill -9 -f "$pattern" 2>/dev/null || :',
    '}',
    '',
    'roll_back() {',
    '  rm -rf "$target"',
    '  if out=$(mv "$backup" "$app" 2>&1); then return 0; fi',
    '  log "could not put the previous version back: $out"',
    '  log "the previous version is in $backup"',
    '  return 1',
    '}',
    '',
    'if ! wait_for_quit; then',
    '  roll_back',
    `  record swap ${shQuote(quitTimeoutReason(quitSeconds))}`,
    '  exit 1',
    'fi',
    '',
    'announce_start',
    'open -W -n "$target" >/dev/null 2>&1 &',
    'opener=$!',
    'if await_start "$opener"; then',
    // `open -W` would otherwise wait for as long as the app runs.
    '  kill "$opener" 2>/dev/null',
    '  rm -rf "$backup"',
    '  rm -rf "$work"',
    '  confirmed',
    '  exit 0',
    'fi',
    '',
    'stop_new "$opener"',
    'record start "$reason"',
    'if roll_back; then',
    "  log 'starting the previous version again'",
    '  open "$app"',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

/**
 * Linux: end a new version that did not confirm. It is a child of the helper,
 * so its PID is known.
 */
const POSIX_STOP_CHILD = [
  'stop_new() {',
  '  kill "$1" 2>/dev/null || return 0',
  '  i=0',
  '  while kill -0 "$1" 2>/dev/null && [ "$i" -lt 25 ]; do sleep 0.2; i=$((i+1)); done',
  '  kill -9 "$1" 2>/dev/null || :',
  '}',
  '',
].join('\n');

/**
 * Linux, AppImage: the old file goes aside as `backupPath`, the new one takes
 * its place. Nothing of this can happen in-process — the running AppImage is
 * mounted inside its own process.
 */
function buildLinuxAppImageScript({
  pid, appImagePath, stagedPath, backupPath = `${appImagePath}.old`, workDir,
  version, logFile, statusFile, pendingFile, quitSeconds, startSeconds,
}) {
  return [
    buildPosixPrelude({ pid, version, logFile, statusFile, pendingFile, quitSeconds, startSeconds }),
    `image=${shQuote(appImagePath)}`,
    `staged=${shQuote(stagedPath)}`,
    `backup=${shQuote(backupPath)}`,
    `work=${shQuote(workDir)}`,
    '',
    POSIX_STOP_CHILD,
    'if ! wait_for_quit; then',
    '  rm -f "$staged"',
    `  record swap ${shQuote(quitTimeoutReason(quitSeconds))}`,
    '  exit 1',
    'fi',
    '',
    'if ! out=$(mv -f "$image" "$backup" 2>&1); then',
    '  rm -f "$staged"',
    '  record swap "$out"',
    '  exec "$image"',
    'fi',
    'if ! out=$(mv -f "$staged" "$image" 2>&1); then',
    '  mv -f "$backup" "$image"',
    '  rm -f "$staged"',
    '  record swap "$out"',
    '  exec "$image"',
    'fi',
    'chmod 755 "$image"',
    '',
    'announce_start',
    '"$image" >/dev/null 2>&1 &',
    'child=$!',
    'if await_start "$child"; then',
    '  rm -f "$backup"',
    '  rm -rf "$work"',
    '  confirmed',
    '  exit 0',
    'fi',
    '',
    'stop_new "$child"',
    'record start "$reason"',
    'if out=$(mv -f "$backup" "$image" 2>&1); then',
    "  log 'starting the previous version again'",
    '  exec "$image"',
    'fi',
    'log "could not put the previous version back: $out"',
    'log "the previous version is in $backup"',
    'exit 1',
    '',
  ].join('\n');
}

/**
 * Linux, extracted folder: the old folder goes aside as `backupDir`, the
 * staged one takes its place. A rollback starts the old program under the
 * name it had (`previousBinaryName`, #794).
 */
function buildLinuxDirScript({
  pid, installDir, stagedDir, backupDir, workDir, binaryName = LINUX_BINARY_NAME,
  previousBinaryName = binaryName, version, logFile, statusFile, pendingFile, quitSeconds, startSeconds,
}) {
  return [
    buildPosixPrelude({ pid, version, logFile, statusFile, pendingFile, quitSeconds, startSeconds }),
    `install=${shQuote(installDir)}`,
    `staged=${shQuote(stagedDir)}`,
    `backup=${shQuote(backupDir)}`,
    `work=${shQuote(workDir)}`,
    `bin=${shQuote(path.posix.join(installDir, binaryName))}`,
    `oldbin=${shQuote(path.posix.join(installDir, previousBinaryName))}`,
    '',
    POSIX_STOP_CHILD,
    'relaunch_old() {',
    "  log 'starting the previous version again'",
    '  exec "$oldbin"',
    '}',
    '',
    'if ! wait_for_quit; then',
    '  rm -rf "$staged"',
    `  record swap ${shQuote(quitTimeoutReason(quitSeconds))}`,
    '  exit 1',
    'fi',
    '',
    'if ! out=$(mv "$install" "$backup" 2>&1); then',
    '  rm -rf "$staged"',
    '  record swap "$out"',
    '  relaunch_old',
    'fi',
    // Scheitert der zweite Zug, steht die alte Version wieder da — besser eine
    // nicht aktualisierte App als gar keine.
    'if ! out=$(mv "$staged" "$install" 2>&1); then',
    '  mv "$backup" "$install"',
    '  rm -rf "$staged"',
    '  record swap "$out"',
    '  relaunch_old',
    'fi',
    '',
    'announce_start',
    '"$bin" >/dev/null 2>&1 &',
    'child=$!',
    'if await_start "$child"; then',
    '  rm -rf "$backup"',
    '  rm -rf "$work"',
    '  confirmed',
    '  exit 0',
    'fi',
    '',
    'stop_new "$child"',
    'record start "$reason"',
    'rm -rf "$install"',
    'if out=$(mv "$backup" "$install" 2>&1); then',
    '  relaunch_old',
    'fi',
    'log "could not put the previous version back: $out"',
    'log "the previous version is in $backup"',
    'exit 1',
    '',
  ].join('\n');
}

/** How long the Windows helper waits for the new version to confirm its start. */
const WINDOWS_START_SECONDS = 120;

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
 * The backup outlives the start of the new version, as on macOS and Linux
 * (#1003, #1067): the helper writes `pendingFile`, starts the new `.exe` and
 * waits until that file is gone. If the new process ends first, or nothing
 * happens within `startSeconds`, the helper stops it, swaps the folders back,
 * records the stage `start` and starts the old `.exe`.
 *
 * `carryOver` lists entries of the app folder that are not part of the new
 * package (the downloaded ZIP, say). Once the new version runs they move into
 * its folder instead of being deleted along with the backup; until then they
 * stay with the backup, which a rollback puts back as it is.
 *
 * `startedFile` is written as soon as the script runs, before it waits for
 * the app: the launcher holds the app back until it sees that file (#654).
 */
function buildWindowsSwapScript({
  pid, installDir, stagedDir, stageRoot = stagedDir, backupDir, workDir,
  logFile, statusFile, pendingFile, startedFile, version = '', carryOver = [], exeName = WINDOWS_EXE_NAME,
  previousExeName = exeName, startSeconds = WINDOWS_START_SECONDS,
}) {
  const carry = carryOver.length > 0 ? `@(${carryOver.map(psQuote).join(', ')})` : '@()';
  const seconds = Number(startSeconds);
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
    `$pending = ${psQuote(pendingFile)}`,
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
    // `swap` when the new version could not be put in place, `start` when it
    // was but did not start (#1003).
    'function Write-Failure([string]$step, [string]$reason) {',
    "  Write-Log ('update failed: ' + $reason)",
    '  try {',
    '    [ordered]@{ version = $version; stage = $step; error = $reason; log = $log; at = (Get-Date -Format o) } |',
    '      ConvertTo-Json | Set-Content -LiteralPath $status -Encoding UTF8',
    '  } catch { }',
    '  Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue',
    '}',
    '',
    'function Start-PreviousVersion {',
    '  if (Test-Path -LiteralPath $oldExe) {',
    "    Write-Log 'starting the previous version again'",
    '    Start-Process -FilePath $oldExe',
    '  } else {',
    "    Write-Log ('the previous version is in ' + $backup)",
    '  }',
    '}',
    '',
    // Gently first; then the process and whatever else runs from the new
    // folder, which would keep it from being moved back.
    'function Stop-NewVersion($proc) {',
    '  try {',
    '    if (-not $proc.HasExited -and $proc.CloseMainWindow()) {',
    '      for ($i = 0; $i -lt 25 -and -not $proc.HasExited; $i++) { Start-Sleep -Milliseconds 200 }',
    '    }',
    '  } catch { }',
    '  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue',
    "  $prefix = $install.TrimEnd('\\') + '\\'",
    '  try {',
    '    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    '      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } |',
    '      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '  } catch { }',
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
    "  Write-Failure 'swap' $_.Exception.Message",
    '  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
    '  Start-PreviousVersion',
    '  exit 1',
    '}',
    '',
    // ASCII: the version is, and a byte order mark is not JSON.
    'try {',
    '  @{ version = $version } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pending -Encoding ASCII',
    "} catch { Write-Log ('could not write ' + $pending) }",
    "Write-Log 'starting the new version'",
    "$reason = ''",
    'try {',
    '  $new = Start-Process -FilePath $exe -PassThru',
    // Without the handle .NET forgets the exit code of a process it did not wait for.
    '  $null = $new.Handle',
    `  $deadline = (Get-Date).AddSeconds(${seconds})`,
    '  while (Test-Path -LiteralPath $pending) {',
    '    if ($new.HasExited) {',
    '      if (Test-Path -LiteralPath $pending) {',
    "        $reason = 'the new version ended before it had started (exit code ' + $new.ExitCode + ')'",
    '      }',
    '      break',
    '    }',
    '    if ((Get-Date) -gt $deadline) {',
    `      $reason = 'the new version did not start within ${seconds} seconds'`,
    '      break',
    '    }',
    '    Start-Sleep -Milliseconds 200',
    '  }',
    '} catch {',
    "  $reason = 'the new version could not be started: ' + $_.Exception.Message",
    '}',
    '',
    "if ($reason -ne '') {",
    '  if ($new) { Stop-NewVersion $new }',
    "  Write-Failure 'start' $reason",
    // The failed folder goes back where it came from, so that the next
    // install clears it away should it not go now.
    '  try {',
    '    Move-WithRetry $install $staged',
    '    Move-WithRetry $backup $install',
    '  } catch {',
    "    Write-Log ('could not put the previous version back: ' + $_.Exception.Message)",
    "    Write-Log ('the previous version is in ' + $backup)",
    '    exit 1',
    '  }',
    '  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
    '  Start-PreviousVersion',
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

// A staging folder an earlier attempt left next to the app: a failed install
// up to 1.20.1 removed everything in it but `resources/app.asar`, and every
// retry added another one (#914). No helper can still be waiting on one when
// the next install starts — a started helper ends this app.
const STALE_STAGING = /^\.snotra-new-\d+(\.app)?$/;

async function removeStaleStaging(parentDir) {
  const names = await fsp.readdir(parentDir).catch(() => []);
  await Promise.all(names
    .filter((name) => STALE_STAGING.test(name))
    .map((name) => removeTree(path.join(parentDir, name)).catch(() => {})));
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
 * Where a helper reports once this process is gone. They belong outside the
 * app folder and the work folder, which both get replaced or removed; without
 * a caller's choice they go next to the work folder.
 */
function helperFiles({ workDir, logFile, statusFile, pendingFile }) {
  const dir = path.dirname(workDir);
  return {
    logFile: logFile || path.join(dir, 'snotra-update.log'),
    statusFile: statusFile || path.join(dir, 'snotra-update-failed.json'),
    pendingFile: pendingFile || path.join(dir, 'snotra-update-pending.json'),
  };
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

  async function installMacos({ filePath, version, target, workDir, files }) {
    const appBundlePath = target.appBundlePath;
    const parentDir = path.dirname(appBundlePath);
    await assertWritable(parentDir, 'update.place.appFolder');
    await removeStaleStaging(parentDir);

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
      await removeTree(stagedPath).catch(() => {});
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
      await removeTree(stagedPath).catch(() => {});
      throw err;
    }

    const script = path.join(workDir, 'relaunch.sh');
    await fsp.writeFile(script, buildMacRelaunchScript({
      pid: pidOf(), appBundlePath, targetBundlePath: targetPath, backupPath, workDir, version, ...files,
    }), { mode: 0o700 });
    launch('/bin/sh', [script]);
    return { ok: true, relaunching: true, logFile: files.logFile };
  }

  async function installWindows({ filePath, version, target, workDir, files }) {
    const installDir = target.installDir;
    const parentDir = path.win32.dirname(installDir);
    await assertWritable(parentDir, 'update.place.installFolder');
    await removeStaleStaging(parentDir);

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
        await removeTree(stagedDir).catch(() => {});
        throw installError('update.error.archiveMissing', { file: WINDOWS_EXE_NAME });
      }
    }
    try {
      verifyPackageFolder(rootDir, version);
    } catch (err) {
      await removeTree(stagedDir).catch(() => {});
      throw err;
    }

    const carryOver = await listForeignEntries(installDir, rootDir);
    const helperLog = files.logFile;
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
      statusFile: files.statusFile,
      pendingFile: files.pendingFile,
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
      await removeTree(stagedDir).catch(() => {});
      throw installError('update.error.helperFailed', { error: launched.error });
    }
    return { ok: true, relaunching: true, logFile: helperLog };
  }

  async function installLinuxAppImage({ filePath, version, target, workDir, files }) {
    const appImagePath = target.appImagePath;
    await assertWritable(path.dirname(appImagePath), 'update.place.appImageFolder');

    const stamp = Date.now();
    const stagedPath = `${appImagePath}.new-${stamp}`;
    await fsp.copyFile(filePath, stagedPath);
    await fsp.chmod(stagedPath, 0o755);

    const script = path.join(workDir, 'relaunch.sh');
    await fsp.writeFile(script, buildLinuxAppImageScript({
      pid: pidOf(), appImagePath, stagedPath, backupPath: `${appImagePath}.old-${stamp}`, workDir, version, ...files,
    }), { mode: 0o700 });
    launch('/bin/sh', [script]);
    return { ok: true, relaunching: true, logFile: files.logFile };
  }

  async function installLinuxDir({ filePath, version, target, workDir, files }) {
    const installDir = target.installDir;
    const parentDir = path.posix.dirname(installDir);
    await assertWritable(parentDir, 'update.place.installFolder');
    await removeStaleStaging(parentDir);

    const stamp = Date.now();
    const extractDir = path.join(workDir, `extract-${stamp}`);
    await fsp.mkdir(extractDir, { recursive: true });
    await exec('tar', ['-xzf', filePath, '-C', extractDir]);

    const entries = await fsp.readdir(extractDir, { withFileTypes: true });
    const rootName = entries.find((entry) => entry.isDirectory())?.name || '';
    const extracted = rootName ? path.join(extractDir, rootName) : extractDir;
    const binaryName = findExecutable(extracted, LINUX_BINARY_NAMES);
    if (!binaryName) {
      await removeTree(extractDir).catch(() => {});
      throw installError('update.error.archiveMissing', { file: LINUX_BINARY_NAME });
    }
    try {
      verifyPackageFolder(extracted, version);
    } catch (err) {
      await removeTree(extractDir).catch(() => {});
      throw err;
    }

    // Vor dem Tausch auf dasselbe Dateisystem bringen — ein `mv` ueber
    // Geraetegrenzen hinweg ist kein Umbenennen mehr, sondern ein Kopieren,
    // und das darf nicht erst im Helferskript auffallen.
    const stagedDir = path.join(parentDir, `.snotra-new-${stamp}`);
    await fsp.rename(extracted, stagedDir);
    // A rollback starts the program that is there now, under its name (#794).
    const previousBinaryName = findExecutable(installDir, LINUX_BINARY_NAMES) || binaryName;

    const script = path.join(workDir, 'relaunch.sh');
    await fsp.writeFile(script, buildLinuxDirScript({
      pid: pidOf(),
      installDir,
      stagedDir,
      backupDir: path.join(parentDir, `.snotra-old-${stamp}`),
      workDir,
      binaryName,
      previousBinaryName,
      version,
      ...files,
    }), { mode: 0o700 });
    launch('/bin/sh', [script]);
    return { ok: true, relaunching: true, logFile: files.logFile };
  }

  /**
   * Spielt die geladene Datei ein. Wirft nie — ein Fehler kommt als
   * `{ ok: false, error }` zurueck; die laufende Installation ist dann
   * unveraendert.
   *
   * `logFile` and `statusFile` are where the helper reports once this process
   * is gone (#442, #1003); `pendingFile` is the one the new version removes
   * to say it has started. See `helperFiles`.
   */
  async function install({ filePath, version, target, workDir, logFile, statusFile, pendingFile }) {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: createMessage('update.error.fileGone') };
      }
      if (!target || target.canSelfUpdate !== true) {
        return { ok: false, error: target?.reason || createMessage('update.error.selfUpdateImpossible') };
      }
      await fsp.mkdir(workDir, { recursive: true });

      const files = helperFiles({ workDir, logFile, statusFile, pendingFile });
      const job = { filePath, version, target, workDir, files };
      switch (target.kind) {
        case 'macos-bundle': return await installMacos(job);
        case 'windows-dir': return await installWindows(job);
        case 'linux-appimage': return await installLinuxAppImage(job);
        case 'linux-dir': return await installLinuxDir(job);
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
  ereEscape,
  buildWindowsLaunchCommand,
  encodePowerShell,
  listForeignEntries,
  macTargetBundlePath,
  helperOutputFile,
  readAsarPackageJson,
  shQuote,
  psQuote,
};
