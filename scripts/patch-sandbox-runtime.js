'use strict';

/**
 * Two changes to @anthropic-ai/sandbox-runtime, made after every install.
 *
 * **The ask callback (#792).** The runtime's network proxy asks the host
 * application about a connection that matches no rule — and passes host and
 * port only. Which command opened the connection is known at that very spot
 * (`encodedCommand`, from the proxy credentials every sandboxed command
 * carries), it just is not handed on. Without it Snotra could only guess which
 * run, and so which chat, a waiting connection belongs to; a process that
 * slipped out of its command's process group could then show its connections
 * on another command's card. This adds the command key to the callback's
 * argument, nothing else. Without it Snotra asks about no connection while it
 * waits and offers it on the card after the run instead.
 *
 * **The log monitor (#881).** On macOS the runtime learns what Seatbelt
 * refused from `log stream`, and its monitor reads one entry per chunk of that
 * stream's output: the first deny line it finds, paired with the first
 * `CMD64_` line. Under load `log stream` hands over several entries in one
 * chunk — every one after the first was dropped, often the very refusal a run
 * was about — and an entry split between two chunks could be paired with
 * another entry's command. This puts `snotraOnLogEntry` in front of the
 * monitor, which hands it one complete entry at a time. Without it a refusal
 * can go missing from a run's card and from what the model is told.
 *
 * Nothing breaks when a line to patch is not there; the install only warns.
 * `test/sandbox-live-network.test.js` and `test/sandbox-log-monitor.test.js`
 * fail in that case, so that a runtime update that moved a line is noticed
 * instead of quietly losing what it was for.
 */

const fs = require('fs');
const path = require('path');

const ANCHOR = 'await sandboxAskCallback({ host, port })';
const PATCHED = 'await sandboxAskCallback({ host, port, encodedCommand })';

const MONITOR_ANCHOR = "logProcess.stdout?.on('data', (data) => {";
const MONITOR_PATCHED = "snotraOnLogEntry(logProcess.stdout, (data) => {";

function runtimeFile(name) {
  const entry = require.resolve('@anthropic-ai/sandbox-runtime');
  return path.join(path.dirname(entry), 'sandbox', name);
}

function managerPath() {
  return runtimeFile('sandbox-manager.js');
}

function monitorPath() {
  return runtimeFile('macos-sandbox-utils.js');
}

/**
 * Calls `handler` once per `log stream` entry instead of once per chunk: a
 * Seatbelt deny line together with the `CMD64_…` line that follows it. Its
 * source is copied into the runtime as it stands, so it must not use anything
 * from this file.
 *
 * @param {import('stream').Readable|null|undefined} stream  stdout of `log stream`
 * @param {(entry: string) => void} handler  the runtime's chunk handler
 */
function snotraOnLogEntry(stream, handler) {
  if (!stream) return;
  let rest = '';
  let pending = null;
  stream.on('data', (chunk) => {
    const lines = (rest + chunk.toString()).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (line.includes('Sandbox:') && line.includes('deny')) {
        // A deny line whose command line never came still counts, as before.
        if (pending !== null) handler(pending);
        pending = line;
      } else if (line.startsWith('CMD64_') && pending !== null) {
        handler(`${pending}\n${line}`);
        pending = null;
      }
    }
  });
}

/**
 * @param {string} [file]  the runtime's sandbox-manager.js
 * @returns {'patched'|'already'|'missing'}
 */
function patchSandboxRuntime(file = managerPath()) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(PATCHED)) return 'already';
  const count = source.split(ANCHOR).length - 1;
  if (count !== 1) return 'missing';
  fs.writeFileSync(file, source.replace(ANCHOR, PATCHED));
  return 'patched';
}

/**
 * @param {string} [file]  the runtime's macos-sandbox-utils.js
 * @returns {'patched'|'already'|'missing'}
 */
function patchLogMonitor(file = monitorPath()) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(MONITOR_PATCHED)) return 'already';
  const count = source.split(MONITOR_ANCHOR).length - 1;
  if (count !== 1) return 'missing';
  const helper = `\n// Added by Snotra, scripts/patch-sandbox-runtime.js (#881).\n${snotraOnLogEntry.toString()}\n`;
  const patched = source.replace(MONITOR_ANCHOR, MONITOR_PATCHED);
  // Ahead of the source map comment, which stays the file's last line.
  const map = patched.lastIndexOf('\n//# sourceMappingURL=');
  fs.writeFileSync(file, map >= 0 ? `${patched.slice(0, map)}${helper}${patched.slice(map)}` : `${patched}${helper}`);
  return 'patched';
}

const PATCHES = [
  {
    name: 'ask callback',
    apply: () => patchSandboxRuntime(),
    without: 'connections are offered after the run instead of while it waits (#792)',
  },
  {
    name: 'log monitor',
    apply: () => patchLogMonitor(),
    without: 'refusals that arrive together in the log may go missing from a run (#881)',
  },
];

if (require.main === module) {
  for (const patch of PATCHES) {
    let result;
    try {
      result = patch.apply();
    } catch (e) {
      result = `failed (${e?.message || e})`;
    }
    if (result === 'patched' || result === 'already') {
      console.log(`[patch-sandbox-runtime] ${patch.name}: ${result}`);
    } else {
      // A warning, not a failed install: the app still works without it.
      console.warn(`[patch-sandbox-runtime] ${patch.name}: `
        + `${result === 'missing' ? 'the line to patch was not found' : result} — ${patch.without}.`);
    }
  }
}

module.exports = {
  patchSandboxRuntime, managerPath, ANCHOR, PATCHED,
  patchLogMonitor, monitorPath, MONITOR_ANCHOR, MONITOR_PATCHED, snotraOnLogEntry,
};
