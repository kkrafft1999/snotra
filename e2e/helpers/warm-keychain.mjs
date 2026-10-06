// Creates the app's safeStorage key once, before the e2e files start side by
// side (#689). Runs as part of `pretest:e2e`.
//
// On a fresh macOS runner the keychain has no "Snotra AI Safe Storage" item
// yet, and the first start that finds none creates one. The first test files
// start at the same moment, so several starts created it at once: some came
// up without encryption, and once a restart could not decrypt what the first
// start of the same profile had written — the history was quarantined and
// the policy signature failed. With the item in place before any test runs,
// every start reads the same key.
//
// Only macOS keeps the key in the keychain; elsewhere there is nothing to do.
// A start without encryption does not fail the run here: the tests decide
// what they need, and this line says what they got.

import { KEYCHAIN_SERVICE, keychainItemCount, launchApp, makeTempDir } from './app.mjs';

if (process.platform === 'darwin') {
  const before = await keychainItemCount();
  const snotra = await launchApp({ userDataDir: await makeTempDir('snotra-keychain-userdata-') });
  let state;
  try {
    state = await snotra.app.evaluate(({ safeStorage }) => {
      const available = safeStorage.isEncryptionAvailable();
      return {
        available,
        roundTrip: available && safeStorage.decryptString(safeStorage.encryptString('ok')) === 'ok',
      };
    });
  } finally {
    await snotra.stop();
  }
  const after = await keychainItemCount();
  const items = before === null ? '' : `, items "${KEYCHAIN_SERVICE}": ${before} → ${after}`;
  console.log(`[keychain] safeStorage available: ${state.available}, round trip: ${state.roundTrip}${items}`);
}
