/**
 * RemoteRelay port (#1114, #1192): the blind relay of the mobile remote
 * (#1081), as the desktop sees it — for pairing (docs/remote/remote-protocol.md §5)
 * and for the channel to the paired phone (§12–§16).
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
 * What the desktop reads of `/channels/{channelId}/meta` (protocol §5.10): `null`
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
 * Handshake 1 as the phone wrote it (protocol §13), its shape checked: `v` the
 * versions it speaks, `e` its ephemeral key — whether that is a key is the
 * crypto port's question.
 *
 * @typedef {Object} RemotePhoneHandshake
 * @property {number[]} v
 * @property {string} e
 */

/**
 * One envelope in the desktop's inbox (protocol §15): `sid` and `counter`
 * from its path, `c` the sealed message.
 *
 * @typedef {Object} RemoteEnvelope
 * @property {string} sid  16 hex digits
 * @property {number} counter
 * @property {string} c  base64url
 */

/**
 * The desktop's side of a paired channel (protocol part 2, #1192): the four
 * nodes of §12 followed, and the writes the desktop may make. The adapter
 * fetches the token (§5.9) itself, renews it before it runs out and on
 * `auth_revoked`, and keeps it to itself.
 *
 * @typedef {Object} RemoteChannelHandlers
 * @property {RemoteSigner} sign  for the token's proof
 * @property {() => void} onLive  every stream is connected — after the first connect and after each reconnect
 * @property {(record: RemoteChannelRecord|null) => void} onMeta  `null`: the channel is gone (§12.2)
 * @property {(record: RemotePhoneHandshake|null) => void} onPhoneHandshake
 * @property {(lastSeen: number|null) => void} onPhonePresence  the phone's last heartbeat (§12.3) on this machine's clock, `null` without a record — the core judges its age; never a connection by itself
 * @property {(envelope: RemoteEnvelope) => void} onEnvelope  each envelope once, until it is deleted
 * @property {(error: Error) => void} onError  once, when the channel has failed for good; the link is closed then
 *
 * @typedef {Object} RemoteChannelLink
 * @property {(record: { v: number, e: string } | { error: 'protocol-unsupported', v: number[] }) => Promise<void>} writeHandshake
 * @property {(sid: string, counter: number, c: string) => Promise<void>} writeEnvelope  into `to-phone`, never overwriting
 * @property {(sid: string, counter: number) => Promise<void>} deleteEnvelope  from `to-desktop`
 * @property {() => Promise<void>} writePresence  `presence/desktop = { lastSeen: server time }`
 * @property {() => Promise<void>} deletePresence
 * @property {() => void} close  stops the streams and forgets the token
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
 * @property {(channelId: string, handlers: RemoteChannelHandlers) => RemoteChannelLink} openChannel
 *   part 2 (§12): token, the four streams, the desktop's writes
 * @property {() => void} close  stops every stream and forgets every token
 */

module.exports = {};
