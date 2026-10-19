'use strict';

/**
 * Three changes to @anthropic-ai/sandbox-runtime, made after every install.
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
 * **The SSH relay (#1155).** On Linux the runtime's seccomp filter refuses
 * every `socket(AF_UNIX)` inside a run, so ssh there cannot reach the
 * ssh-agent, and the filter cannot tell one socket path from another. Only
 * the lines the runtime's inner script runs before `apply-seccomp` may open
 * one — that is where its own proxy relays start. This adds one more relay
 * there, and only for a run whose environment names Snotra's launcher in
 * `SNOTRA_SSH_RELAY`: it listens on the run's own loopback and hands each
 * connection to the launcher, which checks git's request and runs ssh with
 * the agent. Without it Git over SSH cannot sign in inside the Linux sandbox.
 * A runtime update has to keep four things, each checked by
 * `test/sandbox-ssh-relay.test.js`: the anchor closes the relay list in
 * `buildSandboxCommand`, ahead of `apply-seccomp`; the runtime still sets a
 * Linux `GIT_SSH_COMMAND` that goes out through its proxy (the launcher runs
 * it); the inner script still runs in the run's own network namespace with
 * `socat`; and the whole route on the Linux runner still signs in.
 *
 * Nothing breaks when a line to patch is not there; the install only warns.
 * `test/sandbox-live-network.test.js`, `test/sandbox-log-monitor.test.js` and
 * `test/sandbox-ssh-relay.test.js` fail in that case, so that a runtime update that moved a line is noticed
 * instead of quietly losing what it was for.
 */

const fs = require('fs');
const path = require('path');

const ANCHOR = 'await sandboxAskCallback({ host, port })';
const PATCHED = 'await sandboxAskCallback({ host, port, encodedCommand })';

const MONITOR_ANCHOR = "logProcess.stdout?.on('data', (data) => {";
const MONITOR_PATCHED = "snotraOnLogEntry(logProcess.stdout, (data) => {";

const RELAY_ANCHOR = '        ...RELAYS_LISTEN,\n    ];';
const RELAY_PATCHED = '        ...RELAYS_LISTEN,\n        ...snotraSshRelay(socat),\n    ];';
const RELAY_MARKER = '// Added by Snotra, scripts/patch-sandbox-runtime.js (#1155).';

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

function linuxPath() {
  return runtimeFile('linux-sandbox-utils.js');
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
 * The inner-script line that starts the SSH relay (#1155), for a run whose
 * environment sets `SNOTRA_SSH_RELAY` to the launcher. It runs before the
 * seccomp filter, beside the runtime's own relays and with the same `socat`;
 * the launcher is started by absolute path, never looked up. The port is the
 * one `ssh-relay-client.sh` connects to; it exists only in the run's own
 * network namespace. `set -f` and an empty IFS keep a space in the
 * launcher's path from splitting it; `pipes` lets the launcher close its
 * output while it still reads (a socket pair is one descriptor for both),
 * and `shut-close` closes the launcher's input when the run's side ends —
 * a pipe cannot be shut down half-way. Copied into the runtime as it stands, so
 * it must not use anything from this file; no `!` anywhere and no `,` in the
 * SYSTEM command (the runtime's note on RELAYS_LISTEN; socat's address syntax).
 *
 * @param {string} socat  the runtime's socat, already quoted for the shell
 * @returns {string[]}
 */
function snotraSshRelay(socat) {
  return [
    '[ -z "${SNOTRA_SSH_RELAY:-}" ] || ' + socat
      + " -t 3600 TCP-LISTEN:2222,bind=127.0.0.1,fork,reuseaddr 'SYSTEM:set -f;IFS=;exec /bin/sh $SNOTRA_SSH_RELAY,pipes,shut-close'"
      + ' >/dev/null 2>&1 &',
  ];
}

/**
 * Appends a helper's source ahead of the source map comment, which stays the
 * file's last line.
 *
 * @param {string} source
 * @param {string} helper
 */
function withHelper(source, helper) {
  const map = source.lastIndexOf('\n//# sourceMappingURL=');
  return map >= 0 ? `${source.slice(0, map)}${helper}${source.slice(map)}` : `${source}${helper}`;
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
  fs.writeFileSync(file, withHelper(source.replace(MONITOR_ANCHOR, MONITOR_PATCHED), helper));
  return 'patched';
}

/**
 * @param {string} [file]  the runtime's linux-sandbox-utils.js
 * @returns {'patched'|'already'|'missing'}
 */
function patchSshRelay(file = linuxPath()) {
  const source = fs.readFileSync(file, 'utf8');
  const helper = `\n${RELAY_MARKER}\n${snotraSshRelay.toString()}\n`;
  if (source.includes(RELAY_PATCHED)) {
    if (source.includes(helper)) return 'already';
    // Patched by an older Snotra: its line stays, the helper is replaced.
    const start = source.indexOf(`\n${RELAY_MARKER}\n`);
    const end = source.indexOf('\n}\n', start);
    if (start < 0 || end < 0) return 'missing';
    fs.writeFileSync(file, `${source.slice(0, start)}${helper}${source.slice(end + 3)}`);
    return 'patched';
  }
  const count = source.split(RELAY_ANCHOR).length - 1;
  if (count !== 1) return 'missing';
  fs.writeFileSync(file, withHelper(source.replace(RELAY_ANCHOR, RELAY_PATCHED), helper));
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
  {
    name: 'ssh relay',
    apply: () => patchSshRelay(),
    without: 'Git over SSH cannot sign in inside the Linux sandbox (#1155)',
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
  patchSshRelay, linuxPath, RELAY_ANCHOR, RELAY_PATCHED, snotraSshRelay,
};
