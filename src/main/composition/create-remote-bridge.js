'use strict';

/**
 * The remote bridge's pairing, put together (#1114): the core's decisions in
 * `src/application/remote/remote-pairing.js` with the adapters of
 * `src/main/remote/` — the relay, the keys kept through `safeStorage`, the
 * protocol's computations — and the desktop's user-confirmation adapter for
 * the *Allow* (#980).
 *
 * Building it starts nothing: no key is created, no request goes out, no
 * stream is opened before the user starts a pairing (R7).
 */

const { createRemotePairing } = require('../../application/remote/remote-pairing');
const { writeFileAtomic } = require('../services/atomic-write');
const { createFirebaseRelayAdapter } = require('../remote/firebase-relay-adapter');
const { createRemoteIdentityStore } = require('../remote/identity-store-adapter');
const { pairingPrompt } = require('../remote/pairing-prompt');
const { createRemotePairingCryptoAdapter } = require('../remote/pairing-protocol');
const { PRODUCTION_RELAY } = require('../remote/relay-endpoint');

/**
 * @param {{
 *   app: { getPath: (name: string) => string },
 *   safeStorage: any,
 *   safeStorageKey?: { whenDurable: () => Promise<unknown> },
 *   fs: typeof import('fs/promises'),
 *   path: typeof import('path'),
 *   fetchImpl?: typeof fetch,
 *   confirmations: import('../../application/ports/user-confirmation-port').UserConfirmationPort,
 *   receipts: { redeem: (receipt: unknown, action: string, subject?: string) => boolean },
 *   getLocale: () => string,
 *   relay?: import('../../application/ports/remote-relay-port').RemoteRelayPort | null,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `relay` replaces the Firebase relay — the in-memory one in tests
 */
function createRemoteBridge({
  app,
  safeStorage,
  safeStorageKey,
  fs,
  path,
  fetchImpl,
  confirmations,
  receipts,
  getLocale,
  relay = null,
  log = console,
}) {
  const pairing = createRemotePairing({
    relay: relay || createFirebaseRelayAdapter({ endpoint: PRODUCTION_RELAY, fetchImpl: fetchImpl || globalThis.fetch }),
    identity: createRemoteIdentityStore({
      safeStorage, safeStorageKey, fs, path, dir: app.getPath('userData'), writeFileAtomic, log,
    }),
    crypto: createRemotePairingCryptoAdapter(),
    confirmations,
    receipts,
    prompt: pairingPrompt(getLocale),
    log,
  });
  return { pairing, dispose: () => pairing.dispose() };
}

module.exports = { createRemoteBridge };
