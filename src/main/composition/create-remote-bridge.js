'use strict';

/**
 * The remote bridge, put together: pairing (#1114) and the channel to the
 * paired phone (#1192). The core's decisions in `src/application/remote/`
 * with the adapters of `src/main/remote/` — the relay, the keys kept through
 * the secret store, the protocol's computations — the desktop's
 * user-confirmation adapter for the *Allow* (#980), and behind the channel's
 * message-layer port the dispatcher with the release list (#1194) — or the
 * stand-in, when no desktop is handed in.
 *
 * Building it starts nothing: no key is created, no request goes out, no
 * stream is opened. `start()` connects the channel — and only when a phone
 * was paired, which the user started (R7).
 */

const nodeCrypto = require('node:crypto');
const { createRemoteChannel } = require('../../application/remote/remote-channel');
const { createRemoteDispatcher } = require('../../application/remote/remote-dispatcher');
const { createRemoteMessageStandIn } = require('../../application/remote/remote-message-stand-in');
const { createRemotePairing } = require('../../application/remote/remote-pairing');
const { createRemotePresence } = require('../../application/remote/remote-presence');
const { translateMessage } = require('../../shared/i18n');
const { writeFileAtomic } = require('../services/atomic-write');
const { createRemoteChannelCryptoAdapter } = require('../remote/channel-protocol');
const { createFirebaseRelayAdapter } = require('../remote/firebase-relay-adapter');
const { createRemoteIdentityStore } = require('../remote/identity-store-adapter');
const { pairingPrompt } = require('../remote/pairing-prompt');
const { createRemotePairingCryptoAdapter } = require('../remote/pairing-protocol');
const { PAIRING_OPEN } = require('../remote/pairing-lock');
const { PRODUCTION_RELAY } = require('../remote/relay-endpoint');
const { createRemoteReleaseStore } = require('../remote/release-store-adapter');

/** Streamed text goes to the phone in one envelope per chat every 150 ms (protocol §17). */
const RELAY_DELTA_BATCH_MS = 150;

/**
 * @param {{
 *   userDataPath: string,
 *   secretStore: import('../../application/ports/secret-store-port').SecretStorePort,
 *   safeStorageKey?: { whenDurable: () => Promise<unknown> },
 *   fs: typeof import('fs/promises'),
 *   path: typeof import('path'),
 *   fetchImpl?: typeof fetch,
 *   confirmations: import('../../application/ports/user-confirmation-port').UserConfirmationPort,
 *   receipts: { redeem: (receipt: unknown, action: string, subject?: string) => boolean },
 *   getLocale: () => string,
 *   getAppVersion?: () => string,
 *   relay?: import('../../application/ports/remote-relay-port').RemoteRelayPort | null,
 *   messages?: import('../../application/ports/remote-message-layer-port').RemoteMessageLayerPort | null,
 *   desktop?: import('../../application/ports/remote-desktop-port').RemoteDesktopPort | null,
 *   normalizeRoot?: (root: unknown) => string|null,
 *   pairingOpen?: boolean,
 *   developerMode?: { isOn: () => boolean, subscribe: (listener: () => void) => unknown } | null,
 *   powerSave?: import('../../application/ports/power-save-port').PowerSavePort | null,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `relay` replaces the Firebase relay — the in-memory one in tests;
 *   `pairingOpen` whether a phone may be paired — this build's `PAIRING_OPEN` (#1110), tests open it;
 *   `developerMode` opens it as well while it is on (#1213);
 *   `desktop` is what the dispatcher reads, and `normalizeRoot` the chat history's naming of a folder —
 *   without a desktop the stand-in answers; `messages` replaces either;
 *   `powerSave` keeps the computer awake while the phone follows a working run (#1196)
 */
function createRemoteBridge({
  userDataPath,
  secretStore,
  safeStorageKey,
  fs,
  path,
  fetchImpl,
  confirmations,
  receipts,
  getLocale,
  getAppVersion = () => '0.0.0',
  relay = null,
  messages = null,
  desktop = null,
  normalizeRoot = (root) => (typeof root === 'string' && root.trim() ? path.resolve(root.trim()) : null),
  pairingOpen = PAIRING_OPEN,
  developerMode = null,
  powerSave = null,
  log = console,
}) {
  const relayPort = relay || createFirebaseRelayAdapter({ endpoint: PRODUCTION_RELAY, fetchImpl: fetchImpl || globalThis.fetch });
  const identity = createRemoteIdentityStore({
    safeStorage: secretStore, safeStorageKey, fs, path, dir: userDataPath, writeFileAtomic, log,
  });
  // Which workspaces the phone may see (§7.5); a release takes a receipt of the native dialog.
  const releases = createRemoteReleaseStore({
    safeStorage: secretStore, safeStorageKey, receipts, normalizeRoot, fs, path, dir: userDataPath, writeFileAtomic, log,
  });
  const dispatcher = desktop
    ? createRemoteDispatcher({ desktop, releases, word: translateMessage, deltaBatchMs: RELAY_DELTA_BATCH_MS, log })
    : null;
  /** @type {ReturnType<typeof createRemoteChannel> | null} */
  let channel = null;
  // What the window says of the phone, and whether the computer stays awake for it (#1196).
  const presence = createRemotePresence({ powerSave, log });
  // When a phone that is away was last there, for the panel (#1233).
  let phoneLastSeen = /** @type {number|null} */ (null);
  const pairing = createRemotePairing({
    relay: relayPort,
    identity,
    crypto: createRemotePairingCryptoAdapter(),
    confirmations,
    receipts,
    prompt: pairingPrompt(getLocale),
    log,
    // The panel says *Connected* when the window's indicator does (#1196).
    connection: { isConnected: () => presence.getState().connected, lastSeen: () => phoneLastSeen },
    // Open in this build, or while developer mode is on (#1213); asked at every start.
    open: () => pairingOpen === true || developerMode?.isOn() === true,
  });
  // Developer mode switched or read: the panel learns whether pairing is open,
  // and a pairing under way stops once it closes (#1213).
  developerMode?.subscribe(() => pairing.refresh());
  channel = createRemoteChannel({
    relay: relayPort,
    identity,
    crypto: createRemoteChannelCryptoAdapter(),
    messages: messages || dispatcher || createRemoteMessageStandIn({ word: translateMessage }),
    word: translateMessage,
    appVersion: getAppVersion,
    newConnectionId: () => nodeCrypto.randomBytes(16).toString('base64url'),
    // The phone disconnected itself: the relay removed the channel (§12.2).
    onGone: (channelId) => { void pairing.forgetChannel(channelId); },
    log,
  });
  // A phone paired, replaced or removed: the channel follows it, and a
  // removed phone takes the indicator with it at once.
  pairing.subscribe((state) => {
    if (!/** @type {{ phone?: unknown }} */ (state)?.phone) presence.end();
    void channel?.refresh();
  });
  // Connected means a standing session with a phone that is there (R8, #1196).
  channel.subscribe(({ connected, phonePresent, phoneLastSeen: seen }) => {
    const moved = seen !== phoneLastSeen;
    phoneLastSeen = seen;
    presence.setConnected(connected && phonePresent);
    if (moved) pairing.notifyConnection();
  });
  presence.subscribe(() => pairing.notifyConnection());

  const started = { value: false };
  return {
    pairing,
    channel,
    presence,
    releases,
    /** Connects the channel when a phone is paired. */
    start() {
      if (started.value) return Promise.resolve();
      started.value = true;
      return channel.start();
    },
    dispose() {
      // The phone hears that the desktop quits before its session ends (§8.2);
      // the presence record goes while the relay link still holds its token.
      if (!messages) dispatcher?.closeAll('quit');
      channel.dispose();
      presence.dispose();
      pairing.dispose();
    },
  };
}

module.exports = { createRemoteBridge };
