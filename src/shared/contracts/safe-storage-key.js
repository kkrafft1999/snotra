'use strict';

/**
 * What a store asks before it writes its first ciphertext with `safeStorage`
 * (#1060, see `safe-storage-key-durability.js` for the why).
 *
 * @typedef {object} SafeStorageKeyDurability
 * @property {() => Promise<void>} whenDurable resolves once the key is on disk
 * @property {() => boolean} wouldWait whether `whenDurable` would not resolve at once
 * @property {() => void} releaseForQuit ends a wait, because the quit writes the key
 */

/**
 * No wait anywhere: macOS, Linux, and the default for callers without one.
 *
 * @type {SafeStorageKeyDurability}
 */
const KEY_ALWAYS_DURABLE = Object.freeze({
  whenDurable: () => Promise.resolve(),
  wouldWait: () => false,
  releaseForQuit: () => {},
});

module.exports = { KEY_ALWAYS_DURABLE };
