/**
 * SecretStore port (#983, AR-08): the one root of every secret Snotra keeps
 * at rest — provider keys, gateway headers, MCP secrets and the web search
 * key, every chat of the history, the key that signs the tool policy, the
 * mobile remote's private keys. The store files carry its ciphertext only.
 *
 * On the desktop it is the operating system's keychain through Electron's
 * `safeStorage`, refused on Linux where that would fall back to plain text
 * (`src/main/electron/safe-storage-backend.js`). A host without a keyring
 * hands in one whose `isEncryptionAvailable()` is false: every store then
 * keeps what it can without a secret and says so, as it does today when the
 * keychain is locked.
 */

/**
 * @typedef {Object} SecretStorePort
 * @property {() => boolean} isEncryptionAvailable  whether `encryptString` works right now
 * @property {(plainText: string) => Buffer} encryptString  throws when it does not
 * @property {(cipherText: Buffer) => string} decryptString  throws on ciphertext of another key
 */

module.exports = {};
