/**
 * RemoteChannelCrypto port (#1192): the computations of
 * docs/remote/remote-protocol.md part 2 the desktop makes for every connection — the
 * answer to a handshake (§13), the session keys (§14) and the envelopes
 * sealed and opened under them (§15).
 *
 * The core decides when a handshake is answered, which version is chosen and
 * what happens to an envelope; the adapter only computes, proven against
 * docs/remote/remote-protocol/channel-v1.json. Key bytes never reach the core: the
 * ephemeral private key is drawn and forgotten inside `answerHandshake`, the
 * session keys live inside the session it returns, and `forget()` drops them.
 */

/**
 * The desktop's long-term P-256 agreement, `ss` of §14: the x-coordinate of
 * the shared point with the other side's agree key. The private key stays
 * with the identity store.
 *
 * @typedef {(otherAgreePoint: string) => Uint8Array} RemoteAgreer
 */

/**
 * One session, from the desktop's side: it seals what goes `to-phone` and
 * opens what comes `to-desktop`.
 *
 * @typedef {Object} RemoteChannelSession
 * @property {string} sid  `th[0..8]` as 16 hex digits — the session's name in the envelope paths
 * @property {(counter: number, plaintext: string) => string} seal  `c` of an envelope, base64url; throws over 256 KiB
 * @property {(counter: number, sealed: string) => string | null} open  the plaintext, or null when the tag does not verify
 * @property {() => void} forget  drops both keys; seal and open throw afterwards
 */

/**
 * @typedef {Object} RemoteHandshakeInput
 * @property {string} channelId  base64url of 16 bytes
 * @property {import('./remote-relay-port').RemoteKeyBundle} desktopKeys
 * @property {import('./remote-relay-port').RemoteKeyBundle} phoneKeys
 * @property {number[]} offered  handshake 1's `v`, in its order
 * @property {number} chosen  the version handshake 2 names
 * @property {string} phoneEphemeral  handshake 1's `e`
 * @property {RemoteAgreer} agree
 */

/**
 * @typedef {Object} RemoteChannelCryptoPort
 * @property {(value: unknown) => boolean} isEphemeralKey  32 bytes, canonical base64url
 * @property {(input: RemoteHandshakeInput) => { desktopEphemeral: string, session: RemoteChannelSession }} answerHandshake
 *   a fresh X25519 pair, `ss`, `ee`, `th` and the keys; throws on an ephemeral key that gives no agreement
 */

module.exports = {};
