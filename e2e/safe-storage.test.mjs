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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { launchApp, makeTempDir } from './helpers/app.mjs';

const SECRET = 'safe-storage-885-secret';

/** What Chromium's OSCrypt on macOS does with the fixed mock password. */
function decryptWithMockKey(encrypted) {
  const key = crypto.pbkdf2Sync('mock_password', 'saltysalt', 1003, 16, 'sha1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  // The first three bytes are the "v10" version prefix.
  return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString('utf8');
}

/** One start of the profile: whether safeStorage is available, and what it makes of `previous`. */
async function startOnce(userDataDir, previous) {
  const snotra = await launchApp({ userDataDir });
  try {
    return await snotra.app.evaluate(({ safeStorage }, prior) => {
      const available = safeStorage.isEncryptionAvailable();
      if (!available) return { available };
      return {
        available,
        encrypted: safeStorage.encryptString(prior.secret).toString('base64'),
        decryptedPrevious: prior.previous
          ? safeStorage.decryptString(Buffer.from(prior.previous, 'base64'))
          : null,
      };
    }, { secret: SECRET, previous });
  } finally {
    await snotra.stop();
  }
}

test('safeStorage works without the login keychain, and survives a restart (#885)', { timeout: 180000 }, async () => {
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
  assert.equal(second.available, true);
  assert.equal(second.decryptedPrevious, SECRET, 'the restart decrypts what the first start encrypted');
});
