'use strict';

/**
 * The key behind safeStorage as on a fresh Windows profile, before Chromium
 * has written it to `Local State` (#1060): every `whenDurable()` waits until
 * the test calls `release()`.
 */
function createHeldSafeStorageKey() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = true;
  let waits = 0;
  let noteAsked;
  const firstAsk = new Promise((resolve) => {
    noteAsked = resolve;
  });
  return {
    whenDurable() {
      waits += 1;
      noteAsked();
      return gate;
    },
    /** Resolves once a store has asked to wait; fails if none does in time. */
    asked(timeoutMs = 2000) {
      let timer;
      const late = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('No store asked to wait for the key.')), timeoutMs);
      });
      return Promise.race([firstAsk, late]).finally(() => clearTimeout(timer));
    },
    wouldWait: () => held,
    releaseForQuit() {},
    release() {
      held = false;
      release();
    },
    /** How often a store asked to wait. */
    get waits() {
      return waits;
    },
  };
}

/** Lets pending promise callbacks and fs callbacks run. */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

module.exports = { createHeldSafeStorageKey, settle };
