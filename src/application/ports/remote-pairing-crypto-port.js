/**
 * RemotePairingCrypto port (#1114): the computations of
 * docs/remote-protocol.md part 1 the desktop makes while it pairs — the
 * pairing code (§4), `MAC_P` and `MAC_D` (§6), the safety phrase (§7).
 *
 * The core decides when each is needed and what follows from it; the adapter
 * only computes, proven against docs/remote-protocol/pairing-v1.json. The
 * pairing secret is drawn inside `createCode` from a CSPRNG and travels only
 * inside the code: it goes to the window as QR code and typed key, and to the
 * MAC functions — never to the relay.
 */

/**
 * @typedef {Object} RemotePairingCode
 * @property {string} code  the twenty symbols; its ASCII bytes are the MAC key `K`
 * @property {string} display  the typed key, in groups of four
 * @property {string} qr  `snotra-pair:v1/<relay host>/<code>`
 */

/**
 * @typedef {Object} RemoteClaimInput
 * @property {string} code
 * @property {string} channelId  base64url of 16 bytes
 * @property {import('./remote-relay-port').RemoteKeyBundle} desktopKeys
 * @property {import('./remote-relay-port').RemoteKeyBundle} phoneKeys
 */

/**
 * @typedef {Object} RemotePairingCryptoPort
 * @property {(pairingId: string, relayHost: string) => RemotePairingCode} createCode
 *   a fresh 75-bit secret behind the relay's pairing id; throws on an id that is not four symbols
 * @property {(keys: unknown) => boolean} isKeyBundle  two valid uncompressed P-256 points
 * @property {(input: RemoteClaimInput & { macP: string }) => boolean} verifyPhoneMac  in constant time
 * @property {(input: RemoteClaimInput) => string} desktopMac  `MAC_D`, base64url
 * @property {(desktopKeys: import('./remote-relay-port').RemoteKeyBundle,
 *   phoneKeys: import('./remote-relay-port').RemoteKeyBundle) => string[]} phrase  the six words
 */

module.exports = {};
