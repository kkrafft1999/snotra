'use strict';

/**
 * The covert-signal check of text the prompt embeds from the open folder (#1280).
 *
 * The folder's `AGENTS.md` and `.agents/memory.md` — and later its rules files —
 * are instructions by design, so the injection detector does not look at them
 * as it looks at a tool result: "from now on" and orders addressed to the agent
 * are what such a file is for. What stays suspicious in them is covert: hiding
 * something from the user, acting without them, sending secrets or the prompt
 * out, image beacons, invisible text (`findCovertSignals`).
 *
 * A hit changes nothing about what is sent. Like an injection flag it is a
 * warning: the context breakdown marks the file, and a card that writes to a
 * knowledge file warns (decision 11 of the knowledge concept). The user's own
 * files are not checked — they are what the user said, not what a folder brought.
 */

const { findCovertSignals } = require('./injection-detector');
const { EMBEDDED_TEXT_GUARDS } = require('./embedded-text-guard');

/**
 * @typedef {{ kind: import('../../shared/contracts/injection-flag').InjectionSignalKind, excerpt: string }} CovertSignal
 */

/**
 * Folder files with the covert signals found in them, as `covertSignals`.
 *
 * @template {{ text?: unknown, guard?: string }} F
 * @param {F[]} files  already through the secret protection (#528)
 * @param {(file: F) => boolean} isFolderFile
 * @returns {Array<F & { covertSignals?: CovertSignal[] }>}
 */
function markCovertSignals(files, isFolderFile) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => {
    // A text that was left out does not reach the model; there is nothing to warn about.
    if (!file || typeof file.text !== 'string' || file.guard === EMBEDDED_TEXT_GUARDS.WITHHELD) return file;
    if (!isFolderFile(file)) return file;
    const signals = findCovertSignals(file.text);
    return signals ? { ...file, covertSignals: signals } : file;
  });
}

/**
 * Whether any part of the prompt was marked for a covert signal — one of the
 * two things a knowledge card warns about, next to an injection flag in the chat.
 *
 * @param {ReadonlyArray<{ covertSignals?: unknown }>} parts
 */
function hasCovertSignal(parts) {
  return Array.isArray(parts) && parts.some((part) => Array.isArray(part?.covertSignals) && part.covertSignals.length > 0);
}

module.exports = {
  markCovertSignals,
  hasCovertSignal,
};
