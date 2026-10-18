/**
 * RemoteRelay port (#1114): the blind relay of the mobile remote (#1081), as
 * the desktop's half of the pairing sees it — docs/remote-protocol.md §5.
 *
 * The core names channels and pairings by their ids and nothing else. Tokens,
 * challenges and the proofs that sign them stay inside the adapter: a relay
 * token never reaches the core, a log line or the window. The proofs are
 * signed through the `sign` the core hands in, so the adapter never holds a
 * private key either.
 *
 * Every adapter treats what the relay sends as untrusted: ids, keys and MACs
 * are checked for their shape before the core sees them, and anything else is
 * a `RemoteRelayError` with reason `invalid-response`. A failed call rejects
 * with a `RemoteRelayError`, whose `reason` is one of
 * `REMOTE_PAIRING_REASONS` or the relay's own `not-found` / `busy` — never a
 * message that could carry a URL or a token.
 *
 * Nothing happens before a method is called (R7): building an adapter opens
 * no connection.
 */

/**
 * A key bundle as it travels: two uncompressed P-256 points, base64url.
 *
 * @typedef {Object} RemoteKeyBundle
 * @property {string} sign
 * @property {string} agree
 */

/**
 * Signs a message with the desktop's long-term sign key (ECDSA P-256,
 * SHA-256, IEEE P1363). The key itself stays with the identity store.
 *
 * @typedef {(message: Uint8Array) => Uint8Array} RemoteSigner
 */

/**
 * What the desktop reads of `/channels/{channelId}` (protocol §5.10): `null`
 * once the record is gone — cancelled, denied, expired or removed.
 *
 * @typedef {Object} RemoteChannelRecord
 * @property {'open'|'pending'|'paired'} status
 * @property {RemoteKeyBundle|null} phoneKeys
 * @property {string|null} macP
 */

/**
 * @typedef {Object} RemoteOpenedPairing
 * @property {string} channelId  16 bytes, base64url
 * @property {string} pairingId  four symbols, minted by the relay
 * @property {number} expiresAt  the relay's clock, ms
 * @property {string} relayHost  the host the QR code names
 */

/**
 * @typedef {Object} RemoteRelayPort
 * @property {(input: { desktopKeys: RemoteKeyBundle, sign: RemoteSigner }) => Promise<RemoteOpenedPairing>} openPairing
 *   §5.2–5.3: a challenge, the signed open, and the desktop's token for the new channel
 * @property {(channelId: string, handlers: {
 *   onRecord: (record: RemoteChannelRecord|null) => void,
 *   onError: (error: Error) => void,
 * }) => { close: () => void }} watchChannel
 *   follows the channel until closed; `onError` once, when following has failed for good
 * @property {(channelId: string, macD: string) => Promise<void>} confirmPairing  §5.6
 * @property {(channelId: string, pairingId: string) => Promise<void>} cancelPairing  §5.7
 * @property {(channelId: string, input: { sign: RemoteSigner }) => Promise<void>} deleteChannel
 *   §5.8, with a fresh token (§5.9) when the adapter holds none for the channel
 * @property {() => void} close  stops every stream and forgets every token
 */

module.exports = {};
