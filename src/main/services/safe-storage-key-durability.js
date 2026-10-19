'use strict';

/**
 * Whether the key behind `safeStorage` has reached the disk yet (#1060).
 *
 * On Windows `safeStorage` encrypts with Chromium's os_crypt key. Unlike on
 * macOS (Keychain) or Linux (libsecret, kwallet), no keystore of the operating
 * system holds that key: it is wrapped with DPAPI and kept as
 * `os_crypt.encrypted_key` in the profile's `Local State` file. On a fresh
 * profile Chromium makes the key at start-up, before the app is ready, but
 * writes `Local State` only on a timer about ten seconds later, or on an
 * orderly quit. `encryptString` works with the key in memory at once, so
 * ciphertext written in that window outlives its key if the process dies: the
 * next start makes a new key, and what the old one encrypted can never be read
 * again — the history is set aside, the policy key replaced, stored provider
 * keys show as undecryptable.
 *
 * `whenDurable()` resolves once `Local State` holds the key, and the stores
 * write their first ciphertext after it. On other platforms, and on every
 * later start, it resolves at once. The wait has a cap: should the key not
 * show up — a Chromium that keeps it somewhere else — the writes go ahead after
 * `capMs` with a warning, as they did before. An orderly quit ends the wait as
 * well, because the quit writes `Local State` on its way out, after the writes
 * held for it.
 *
 * Not covered: a `Local State` whose key DPAPI can no longer open, as in a
 * profile copied to another Windows account. Chromium then makes a new key in
 * memory while the file still holds the old one, which reads as "on disk".
 * What the old key encrypted is lost at that point anyway.
 */

const { KEY_ALWAYS_DURABLE } = require('../../shared/contracts/safe-storage-key');

const LOCAL_STATE_FILENAME = 'Local State';
/** How often `Local State` is looked at while a write waits. */
const KEY_POLL_MS = 250;
/** Chromium writes after 10 s; twice that, counted from creation, is the cap. */
const KEY_WAIT_CAP_MS = 20000;

/**
 * @param {object} deps
 * @param {string} [deps.platform]
 * @param {() => string} deps.localStatePath path of Chromium's `Local State`
 * @param {(filePath: string) => Promise<string>} deps.readFile
 */
function createSafeStorageKeyDurability({
  platform = process.platform,
  localStatePath,
  readFile,
  log = console,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pollMs = KEY_POLL_MS,
  capMs = KEY_WAIT_CAP_MS,
}) {
  if (platform !== 'win32') return KEY_ALWAYS_DURABLE;

  const startedAt = now();
  let settled = false;
  let waiters = [];
  let waitingSince = null;
  let timer = null;
  let checking = null;

  async function keyOnDisk() {
    try {
      const data = JSON.parse(await readFile(localStatePath()));
      const key = data?.os_crypt?.encrypted_key;
      return typeof key === 'string' && key.length > 0;
    } catch {
      // Missing (not written yet), held while Chromium replaces it, or not
      // JSON: in each case the key is not there yet.
      return false;
    }
  }

  function settle(reason) {
    if (settled) return;
    settled = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (reason === 'cap') {
      log?.warn?.(
        `[safe-storage] No encryption key in ${LOCAL_STATE_FILENAME} ${Math.round((now() - startedAt) / 1000)} s after the start; `
        + 'encrypted data is written without waiting for it (#1060).'
      );
    } else if (waitingSince !== null) {
      const waited = ((now() - waitingSince) / 1000).toFixed(1);
      log?.info?.(reason === 'quit'
        ? `[safe-storage] Quit after ${waited} s of waiting for the encryption key; the held writes go ahead, the quit writes the key.`
        : `[safe-storage] The encryption key reached ${LOCAL_STATE_FILENAME} after ${waited} s; the held writes go ahead.`);
    }
    const resolveAll = waiters;
    waiters = [];
    for (const resolve of resolveAll) resolve();
  }

  async function check() {
    if (await keyOnDisk()) {
      settle('durable');
      return;
    }
    if (settled) return;
    if (now() - startedAt >= capMs) {
      settle('cap');
      return;
    }
    // Looked at again only while a write waits for it.
    if (waiters.length > 0 && timer === null) {
      timer = setTimer(() => {
        timer = null;
        runCheck();
      }, pollMs);
    }
  }

  function runCheck() {
    if (settled || checking) return;
    checking = check().finally(() => {
      checking = null;
    });
  }

  // The first look right away: on every later start it finds the key, and
  // nothing ever waits.
  runCheck();

  return {
    /** Resolves once ciphertext may be written; at once when it already may. */
    whenDurable() {
      if (settled) return Promise.resolve();
      if (waitingSince === null) waitingSince = now();
      const pending = new Promise((resolve) => waiters.push(resolve));
      if (timer === null) runCheck();
      return pending;
    },
    /** True while `whenDurable()` would not resolve at once. */
    wouldWait: () => !settled,
    /** An orderly quit has begun: it writes `Local State` itself. */
    releaseForQuit: () => settle('quit'),
  };
}

module.exports = {
  createSafeStorageKeyDurability,
  KEY_ALWAYS_DURABLE,
  KEY_POLL_MS,
  KEY_WAIT_CAP_MS,
  LOCAL_STATE_FILENAME,
};
