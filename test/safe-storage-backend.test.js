'use strict';

// AR-37 (#1012): Linux's basic_text backend of safeStorage is not encryption,
// and must not count as available.

const test = require('node:test');
const assert = require('node:assert/strict');
const { requireRealEncryption, createSafeStorageSecretStore } = require('../src/main/electron/safe-storage-backend');

function fakeSafeStorage(backend, { available = true } = {}) {
  return {
    calls: [],
    isEncryptionAvailable() { return available; },
    getSelectedStorageBackend() {
      if (backend instanceof Error) throw backend;
      return backend;
    },
    encryptString(text) { this.calls.push(['encrypt', text]); return Buffer.from(`enc:${text}`); },
    decryptString(buffer) { this.calls.push(['decrypt']); return buffer.toString().replace(/^enc:/, ''); },
  };
}

test('basic_text on Linux counts as unavailable, and encryptString refuses', () => {
  const raw = fakeSafeStorage('basic_text');
  const guarded = requireRealEncryption(raw, { platform: 'linux' });
  assert.equal(guarded.isEncryptionAvailable(), false);
  assert.throws(() => guarded.encryptString('sk-secret'), /basic_text/);
  assert.deepEqual(raw.calls, [], 'nothing reached the plain-text backend');
});

test('a real secret store on Linux passes through', () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    const raw = fakeSafeStorage(backend);
    const guarded = requireRealEncryption(raw, { platform: 'linux' });
    assert.equal(guarded.isEncryptionAvailable(), true, backend);
    const encrypted = guarded.encryptString('sk-secret');
    assert.equal(guarded.decryptString(encrypted), 'sk-secret', backend);
    assert.equal(guarded.getSelectedStorageBackend(), backend);
  }
});

test('Electron saying "unavailable" still wins over a real backend', () => {
  const guarded = requireRealEncryption(fakeSafeStorage('gnome_libsecret', { available: false }), { platform: 'linux' });
  assert.equal(guarded.isEncryptionAvailable(), false);
});

test('a backend that cannot be named counts as unavailable', () => {
  const guarded = requireRealEncryption(fakeSafeStorage(new Error('not ready')), { platform: 'linux' });
  assert.equal(guarded.isEncryptionAvailable(), false);
});

test('macOS and Windows get safeStorage unchanged', () => {
  for (const platform of ['darwin', 'win32']) {
    const raw = fakeSafeStorage('basic_text');
    assert.equal(requireRealEncryption(raw, { platform }), raw, platform);
  }
});

test('the secret store asks the guarded safeStorage on every call (#983)', () => {
  const guarded = requireRealEncryption(fakeSafeStorage('basic_text'), { platform: 'linux' });
  const store = createSafeStorageSecretStore(guarded);
  assert.deepEqual(Object.keys(store).sort(), ['decryptString', 'encryptString', 'isEncryptionAvailable']);
  assert.equal(store.isEncryptionAvailable(), false);
  assert.throws(() => store.encryptString('secret'), /basic_text/);
});
