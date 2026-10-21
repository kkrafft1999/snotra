'use strict';

/**
 * Only real encryption counts as encryption (AR-37, #1012).
 *
 * On Linux `safeStorage` takes its key from the desktop's secret store
 * (libsecret, kwallet). Without one it falls back to the `basic_text`
 * backend, whose key is a password built into Chromium: anyone who can read
 * the profile can read what it "encrypted". Electron 44 already reports that
 * backend as unavailable unless the app calls `setUsePlainTextEncryption(true)`,
 * which Snotra never does. This wrapper holds the same line without resting on
 * that default: while `basic_text` is selected, `isEncryptionAvailable()` is
 * false and `encryptString()` refuses, so every store takes the path it takes
 * on a system without encryption — no keys stored, and the settings say why.
 *
 * Off Linux there is no such backend, and `safeStorage` is passed on as it is.
 *
 * `createSafeStorageSecretStore` hands the guarded `safeStorage` to the stores
 * as the secret-store port (#983).
 */

const PLAIN_TEXT_BACKENDS = new Set(['basic_text']);

/**
 * The part of Electron's `safeStorage` the stores use, and the one question
 * this wrapper asks of it.
 *
 * @typedef {Object} SafeStorageLike
 * @property {() => boolean} isEncryptionAvailable
 * @property {(plainText: string) => Buffer} encryptString
 * @property {() => string} getSelectedStorageBackend
 */

/**
 * @template {SafeStorageLike} T
 * @param {T} safeStorage  a missing one (a test) comes back as it is
 * @param {{ platform?: string }} [options]
 * @returns {T}
 */
function requireRealEncryption(safeStorage, { platform = process.platform } = {}) {
  if (platform !== 'linux' || !safeStorage) return safeStorage;

  const usesPlainText = () => {
    try {
      return PLAIN_TEXT_BACKENDS.has(safeStorage.getSelectedStorageBackend());
    } catch {
      // A backend that cannot be named is no secret store either.
      return true;
    }
  };

  const guarded = {
    isEncryptionAvailable: () => !usesPlainText() && safeStorage.isEncryptionAvailable(),
    /** @param {string} plainText */
    encryptString: (plainText) => {
      if (usesPlainText()) throw new Error('Encryption is not available: the basic_text backend stores in plain text.');
      return safeStorage.encryptString(plainText);
    },
  };

  return new Proxy(safeStorage, {
    get(target, prop) {
      if (Object.hasOwn(guarded, prop)) return Reflect.get(guarded, prop);
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The secret-store port on the desktop (#983): `safeStorage`, after
 * `requireRealEncryption`. Each call goes to it when it is made, so a
 * keychain unlocked later is used from then on.
 *
 * @param {Pick<import('electron').SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>} safeStorage
 * @returns {import('../../application/ports/secret-store-port').SecretStorePort}
 */
function createSafeStorageSecretStore(safeStorage) {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptString(plainText),
    decryptString: (cipherText) => safeStorage.decryptString(cipherText),
  };
}

module.exports = { requireRealEncryption, createSafeStorageSecretStore };
