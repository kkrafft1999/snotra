'use strict';

/**
 * One line in @anthropic-ai/sandbox-runtime, changed after every install
 * (#792).
 *
 * The runtime's network proxy asks the host application about a connection
 * that matches no rule — and passes host and port only. Which command opened
 * the connection is known at that very spot (`encodedCommand`, from the proxy
 * credentials every sandboxed command carries), it just is not handed on.
 * Without it Snotra could only guess which run, and so which chat, a waiting
 * connection belongs to; a process that slipped out of its command's process
 * group could then show its connections on another command's card. This adds
 * the command key to the callback's argument, nothing else.
 *
 * Nothing breaks when the line is not there: Snotra then asks about no
 * connection while it waits and offers it on the card after the run instead.
 * `test/sandbox-live-network.test.js` fails in that case, so that a runtime
 * update that moved the line is noticed instead of quietly losing the prompt.
 */

const fs = require('fs');
const path = require('path');

const ANCHOR = 'await sandboxAskCallback({ host, port })';
const PATCHED = 'await sandboxAskCallback({ host, port, encodedCommand })';

function managerPath() {
  const entry = require.resolve('@anthropic-ai/sandbox-runtime');
  return path.join(path.dirname(entry), 'sandbox', 'sandbox-manager.js');
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

if (require.main === module) {
  let result;
  try {
    result = patchSandboxRuntime();
  } catch (e) {
    result = `failed (${e?.message || e})`;
  }
  if (result === 'patched' || result === 'already') {
    console.log(`[patch-sandbox-runtime] ${result}`);
  } else {
    // A warning, not a failed install: the app still works without it.
    console.warn(`[patch-sandbox-runtime] ${result === 'missing' ? 'the line to patch was not found' : result} — `
      + 'connections are offered after the run instead of while it waits (#792).');
  }
}

module.exports = { patchSandboxRuntime, managerPath, ANCHOR, PATCHED };
