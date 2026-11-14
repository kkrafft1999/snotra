// safeStorage in the test runs does not touch the login keychain (#885).
//
// launchApp puts --use-mock-keychain on the command line. On macOS Chromium
// then encrypts with a fixed test key instead of the "Snotra AI Safe Storage"
// item — which would ask for access after every Electron update, and would
// hand the installed app's key to a binary any dependency update can replace.
//
// The test home has no Library/Keychains, so a start that still reached for
// the keychain would come up without encryption (or sit at the dialog). Three
// things hold the switch in place: safeStorage is available, what it encrypts
// decrypts with the mock key in plain Node (so it is not the keychain's key),
// and a restart of the same profile decrypts it again. Windows has no keychain
// and Linux has its own backend; there only the restart is checked, and only
// when the platform offers encryption at all.
//
// On Windows the restart failed once to decrypt (#1394). There the key behind
// safeStorage is Chromium's os_crypt key, kept in the profile's `Local State`
// (see src/main/services/safe-storage-key-durability.js, #1060). This test
// calls safeStorage directly, past the app's wait for that key, so it relies
// on the first quit writing `Local State`. To tell the causes apart the next
// time, the test reads the key from `Local State` before and after each quit
// and puts the readings into the failure message; on Windows it also prints
// them on a green run, so the log shows whether the first quit wrote the key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { launchApp, makeTempDir } from './helpers/app.mjs';

const require = createRequire(import.meta.url);
const { LOCAL_STATE_FILENAME } = require('../src/main/services/safe-storage-key-durability.js');

const SECRET = 'safe-storage-885-secret';
/** How much of main's output a failure carries. */
const MAIN_OUTPUT_TAIL = 2000;

/** What Chromium's OSCrypt on macOS does with the fixed mock password. */
function decryptWithMockKey(encrypted) {
  const key = crypto.pbkdf2Sync('mock_password', 'saltysalt', 1003, 16, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  // The first three bytes are the "v10" version prefix.
  return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString('utf8');
}

/**
 * What `Local State` holds of the os_crypt key, in a few words. A key is named
 * by a short hash, so two readings can be compared without printing the key.
 */
async function readLocalStateKey(sessionDataDir) {
  let text;
  try {
    text = await fs.readFile(path.join(sessionDataDir, LOCAL_STATE_FILENAME), 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? 'no Local State' : `Local State unreadable (${error.code ?? error.message})`;
  }
  let key;
  try {
    key = JSON.parse(text)?.os_crypt?.encrypted_key;
  } catch {
    return 'Local State is not JSON';
  }
  if (typeof key !== 'string' || key.length === 0) return 'Local State without the key';
  return `key ${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

/** The version prefix of a ciphertext: "v10" when the os_crypt key made it. */
function cipherPrefix(base64) {
  const head = Buffer.from(base64, 'base64').subarray(0, 3);
  const text = head.toString('latin1');
  return /^v\d\d$/.test(text) ? text : `bytes ${head.toString('hex')}`;
}

/**
 * One start of the profile: whether safeStorage is available, and what it
 * makes of `previous`. `localState` reads `Local State` while the app runs and
 * after it quit.
 */
async function startOnce(userDataDir, previous) {
  const snotra = await launchApp({ userDataDir });
  let result;
  try {
    result = await snotra.app.evaluate(({ app, safeStorage }, prior) => {
      const sessionData = app.getPath('sessionData');
      const available = safeStorage.isEncryptionAvailable();
      if (!available) return { available, sessionData };
      let decryptedPrevious = null;
      let decryptError = null;
      if (prior.previous) {
        try {
          decryptedPrevious = safeStorage.decryptString(Buffer.from(prior.previous, 'base64'));
        } catch (error) {
          decryptError = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        available,
        sessionData,
        encrypted: safeStorage.encryptString(prior.secret).toString('base64'),
        decryptedPrevious,
        decryptError,
      };
    }, { secret: SECRET, previous });
    result.localStateWhileRunning = await readLocalStateKey(result.sessionData);
  } finally {
    await snotra.stop();
  }
  result.localStateAfterQuit = await readLocalStateKey(result.sessionData);
  result.mainOutputTail = snotra.mainOutput().slice(-MAIN_OUTPUT_TAIL);
  return result;
}

/** What both starts found in `Local State`, one line each. */
function readingsOf(first, second) {
  return [
    `ciphertext of the first start: ${cipherPrefix(first.encrypted)}`,
    `Local State, first start running: ${first.localStateWhileRunning}`,
    `Local State, after the first quit: ${first.localStateAfterQuit}`,
    `Local State, second start running: ${second.localStateWhileRunning}`,
    `Local State, after the second quit: ${second.localStateAfterQuit}`,
  ];
}

/**
 * What the readings point to when the restart did not decrypt. Only on
 * Windows: macOS and Linux keep the key outside `Local State`.
 */
function verdictOf(first, second) {
  if (!first.localStateAfterQuit.startsWith('key ')) {
    return '→ the first quit did not leave the key on disk; the second start made a new one';
  }
  if (second.localStateAfterQuit !== first.localStateAfterQuit) {
    return '→ the key on disk changed: the second start could not open it and made a new one';
  }
  return '→ the key on disk stayed the same: the cause is not the key in Local State';
}

test('safeStorage works without the login keychain, and survives a restart (#885)', { timeout: 180000 }, async (t) => {
  const userDataDir = await makeTempDir('snotra-safe-storage-userdata-');

  const first = await startOnce(userDataDir, null);
  if (process.platform === 'darwin') {
    assert.equal(first.available, true, 'safeStorage is available from the mock keychain alone');
    assert.equal(
      decryptWithMockKey(Buffer.from(first.encrypted, 'base64')),
      SECRET,
      'it encrypted with the fixed mock key, not with the key of a keychain item'
    );
  }
  if (!first.available) return; // This platform offers no encryption to a test run.

  const second = await startOnce(userDataDir, first.encrypted);
  const readings = readingsOf(first, second);
  const onWindows = process.platform === 'win32';
  if (onWindows) {
    for (const line of readings) t.diagnostic(line);
  }
  assert.equal(second.available, true);
  assert.equal(
    second.decryptedPrevious,
    SECRET,
    [
      `the restart decrypts what the first start encrypted${second.decryptError ? ` — ${second.decryptError}` : ''}`,
      ...readings,
      ...(onWindows ? [verdictOf(first, second)] : []),
      `main, first start (last ${MAIN_OUTPUT_TAIL} characters):`,
      first.mainOutputTail || '(nothing)',
    ].join('\n')
  );
});
