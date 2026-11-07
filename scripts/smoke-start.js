#!/usr/bin/env node
'use strict';

/**
 * Starts a packaged build once and waits until it reports that it is up
 * (#1066). The release pipeline runs it on every artifact it is about to
 * publish, so a package that crashes at start — a missing native module, a
 * broken asar, a fuse that does not match — fails the release instead of
 * reaching the users.
 *
 * The signal is the one the update helper waits for (#1003): the script writes
 * `update-install-pending.json` into a fresh user data folder and starts the
 * app on that folder with `--user-data-dir`. Once the main window is open, the
 * app removes the file (`confirmInstallStarted` in
 * src/main/services/update-service.js). The start fails when the process ends
 * first, or when nothing happens within the time-out — two minutes, as in the
 * helper. On success the app is ended again; it has done what was asked of it.
 *
 * `SNOTRA_NO_UPDATE_CHECK=1` keeps the started app from asking GitHub for a
 * newer version.
 *
 * Usage:
 *   node scripts/smoke-start.js [--timeout <seconds>] [--label <name>] -- <executable> [args…]
 *
 * Exit code 0 when the app confirmed its start, 1 when it did not, 2 on a
 * wrong call.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** As long as the update helper waits for a new version to start. */
const DEFAULT_TIMEOUT_SECONDS = 120;
const POLL_MS = 250;
/** How long an ended app gets to go before it is killed. */
const STOP_GRACE_MS = 10_000;
/** How much of the app's output and log a failure shows. */
const TAIL_LINES = 200;

const PENDING_FILE = 'update-install-pending.json';

/**
 * @param {string[]} argv  the arguments after the script name
 * @returns {{ timeoutSeconds: number, label: string, command: string, args: string[] }}
 */
function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error('Expected `-- <executable> [args…]`.');
  }
  const options = argv.slice(0, separator);
  const [command, ...args] = argv.slice(separator + 1);
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let label = '';
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    const value = options[i + 1];
    if (option === '--timeout' && value !== undefined) {
      timeoutSeconds = Number(value);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error(`--timeout needs a positive number of seconds, got "${value}".`);
      }
      i += 1;
    } else if (option === '--label' && value !== undefined) {
      label = value;
      i += 1;
    } else {
      throw new Error(`Unknown option "${option}".`);
    }
  }
  return { timeoutSeconds, label: label || path.basename(command), command, args };
}

/** @param {string} text */
function tail(text, lines = TAIL_LINES) {
  const all = String(text).split(/\r?\n/);
  return all.slice(-lines).join('\n');
}

/**
 * Ends the started app and everything it started. On Windows `taskkill /T`
 * takes the whole tree; elsewhere the app runs in a process group of its own
 * (`detached`), which gets SIGTERM first and SIGKILL after a grace period.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ platform?: string, spawnSync?: typeof childProcess.spawnSync, graceMs?: number }} [options]
 * @returns {Promise<void>}  once the process has ended, or the grace is over
 */
function stopTree(child, { platform = process.platform, spawnSync = childProcess.spawnSync, graceMs = STOP_GRACE_MS } = {}) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    child.once('exit', done);
    const signal = (/** @type {NodeJS.Signals} */ name) => {
      try {
        if (platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else if (child.pid) {
          process.kill(-child.pid, name);
        }
      } catch { /* already gone */ }
    };
    signal('SIGTERM');
    timer = setTimeout(() => {
      signal('SIGKILL');
      timer = setTimeout(done, 2_000);
    }, graceMs);
  });
}

/**
 * Removes a folder the app may still hold a file in for a moment (Windows).
 * @param {string} dir
 */
function removeDir(dir, fsImpl = fs) {
  try {
    fsImpl.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    console.warn(`Could not remove ${dir}: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * The app's own log, from the user data folder (`logs/` since #978).
 * @param {string} userDataDir
 * @returns {string}
 */
function readAppLogs(userDataDir, fsImpl = fs) {
  const dir = path.join(userDataDir, 'logs');
  let names;
  try {
    names = fsImpl.readdirSync(dir).sort();
  } catch {
    return '';
  }
  return names.map((name) => {
    try {
      return `--- ${name}\n${tail(fsImpl.readFileSync(path.join(dir, name), 'utf8'))}`;
    } catch {
      return '';
    }
  }).filter(Boolean).join('\n');
}

/**
 * @typedef {Object} SmokeStartResult
 * @property {boolean} ok
 * @property {string} reason        why it failed, empty on success
 * @property {number} elapsedMs     until the confirmation or the failure
 * @property {string} output        the app's stdout and stderr, interleaved
 * @property {string} appLog        the app's own log files
 */

/**
 * @param {Object} params
 * @param {string} params.command
 * @param {string[]} [params.args]
 * @param {string} params.version        written into the pending record
 * @param {number} [params.timeoutMs]
 * @param {number} [params.pollMs]
 * @param {typeof childProcess.spawn} [params.spawn]
 * @param {(child: import('node:child_process').ChildProcess) => Promise<void>} [params.stop]
 * @param {string} [params.tmpDir]
 * @param {string} [params.platform]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {Promise<SmokeStartResult>}
 */
async function smokeStart({
  command,
  args = [],
  version,
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  pollMs = POLL_MS,
  spawn = childProcess.spawn,
  stop,
  tmpDir = os.tmpdir(),
  platform = process.platform,
  env = process.env,
}) {
  const userDataDir = fs.mkdtempSync(path.join(tmpDir, 'snotra-smoke-'));
  const pendingFile = path.join(userDataDir, PENDING_FILE);
  fs.writeFileSync(pendingFile, `${JSON.stringify({ version })}\n`);

  const started = Date.now();
  let output = '';
  /** @type {{ code: number|null, signal: NodeJS.Signals|null }|null} */
  let exited = null;
  /** @type {Error|null} */
  let spawnError = null;

  const child = spawn(command, [...args, `--user-data-dir=${userDataDir}`], {
    env: { ...env, SNOTRA_NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // A process group of its own, so the app and its helpers end together.
    detached: platform !== 'win32',
    windowsHide: false,
  });
  child.stdout?.on('data', (chunk) => { output += chunk; });
  child.stderr?.on('data', (chunk) => { output += chunk; });
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (error) => { spawnError = error; });

  let reason = '';
  for (;;) {
    if (!fs.existsSync(pendingFile)) break;
    if (spawnError) {
      reason = `could not be started: ${/** @type {Error} */ (spawnError).message}`;
      break;
    }
    if (exited) {
      const { code, signal } = /** @type {{ code: number|null, signal: NodeJS.Signals|null }} */ (exited);
      reason = `ended before its window was open (${signal ? `signal ${signal}` : `exit code ${code}`})`;
      break;
    }
    if (Date.now() - started >= timeoutMs) {
      reason = `did not confirm its start within ${Math.round(timeoutMs / 1000)} s`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const elapsedMs = Date.now() - started;

  await (stop ? stop(child) : stopTree(child, { platform }));
  // A helper that outlived the app must not keep this script alive through
  // the inherited pipes.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref?.();
  const appLog = reason ? readAppLogs(userDataDir) : '';
  removeDir(userDataDir);
  return { ok: !reason, reason, elapsedMs, output, appLog };
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error('Usage: node scripts/smoke-start.js [--timeout <seconds>] [--label <name>] -- <executable> [args…]');
    return 2;
  }
  const { version } = require(path.join(ROOT, 'package.json'));
  console.log(`Starting ${parsed.label} (${version}): ${[parsed.command, ...parsed.args].join(' ')}`);
  const result = await smokeStart({
    command: parsed.command,
    args: parsed.args,
    version,
    timeoutMs: parsed.timeoutSeconds * 1000,
  });
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  if (result.ok) {
    console.log(`${parsed.label} started and confirmed after ${seconds} s.`);
    return 0;
  }
  if (result.output.trim()) console.log(`--- output\n${tail(result.output)}`);
  if (result.appLog) console.log(`--- app log\n${result.appLog}`);
  const message = `${parsed.label} ${result.reason} (after ${seconds} s).`;
  // The annotation shows on the run's summary page; a plain line elsewhere.
  console.log(process.env.GITHUB_ACTIONS ? `::error::${message}` : message);
  return 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, smokeStart, stopTree, readAppLogs, PENDING_FILE, DEFAULT_TIMEOUT_SECONDS };
