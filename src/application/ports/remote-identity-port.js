/**
 * RemoteIdentity port (#1114): the desktop's long-term keys for the mobile
 * remote, and the one phone it is paired with (R1) — docs/remote-protocol.md
 * §3, steps 3–4 and 33 of docs/remote-pairing-sequence.svg.
 *
 * The private keys never leave the adapter. The core gets the public bundle
 * and a function that signs; it cannot read, copy or log the key behind it.
 * The adapter keeps everything through `safeStorage`; without real
 * encryption it keeps nothing and `isAvailable()` says so (#1012).
 */

/**
 * @typedef {Object} RemoteIdentity
 * @property {import('./remote-relay-port').RemoteKeyBundle} keys  the public points
 * @property {import('./remote-relay-port').RemoteSigner} sign
 */

/**
 * @typedef {Object} RemotePairedPhone
 * @property {string} channelId
 * @property {import('./remote-relay-port').RemoteKeyBundle} keys  the phone's public points
 * @property {number} pairedAt  ms
 */

/**
 * @typedef {Object} RemoteIdentityPort
 * @property {() => boolean} isAvailable  whether keys can be kept at all
 * @property {() => Promise<RemoteIdentity>} loadIdentity  creates the keys on first use
 * @property {() => Promise<RemotePairedPhone|null>} readPhone
 * @property {(phone: RemotePairedPhone) => Promise<void>} savePhone  replaces the phone kept before (R1)
 * @property {() => Promise<void>} forgetPhone
 */

module.exports = {};
