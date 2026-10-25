/**
 * RemoteMessageLayer port (#1192): where the channel hands over what it has
 * opened. The channel owns `session.hello` and `session.bye` — the first is
 * the key confirmation of docs/remote/remote-protocol.md §14 and mints the
 * connection — and passes every other request of a standing connection here,
 * as `docs/remote/remote-interface.md` §10 answers it: `remote-dispatcher.js` with
 * the release list and the methods of §8.1 (#1194), step 1 so far.
 *
 * `remote-message-stand-in.js` answers every request with `unavailable`
 * (decided on #1192, 2026-10-20); it stands there when no desktop is wired,
 * and holds the channel's own tests apart from the dispatcher.
 */

/**
 * A connection as `docs/remote/remote-interface.md` §7.1 defines it. `kind` is fixed
 * by the channel; `client` is what the phone said and is never trusted.
 *
 * @typedef {Object} RemoteConnection
 * @property {string} id  128 random bits, base64url
 * @property {'relay'} kind
 * @property {{ name: string, version: string }} client
 * @property {string} locale  one of the app's languages, from `session.hello`
 * @property {ReadonlyArray<string>} capabilities
 */

/**
 * A request as it reaches the message layer: the profile of §6.1 already
 * checked — `id` a string or an integer, `params` an object.
 *
 * @typedef {Object} RemoteRequest
 * @property {string|number} id
 * @property {string} method
 * @property {Record<string, unknown>} params
 */

/**
 * @typedef {Object} RemoteHelloAnswer  the parts of `session.hello`'s result the message layer decides
 * @property {string[]} methods  what this connection may call besides `session.hello` and `session.bye`
 * @property {string[]} approvalResponses
 * @property {{ maxRequestBytes: number, maxTextChars: number, maxConnections: number, eventBufferSeconds: number }} limits
 */

/**
 * @typedef {Object} RemoteMessageLayerPort
 * @property {(connection: RemoteConnection) => RemoteHelloAnswer} describe
 * @property {(connection: RemoteConnection, outlet: { send: (event: object) => boolean }) => void} open
 *   the connection stands; `send` puts an event into its channel, false once it has ended
 * @property {(connection: RemoteConnection, request: RemoteRequest) => Promise<object>} handle
 *   the JSON-RPC answer, `result` or `error`, with the request's id
 * @property {(connection: RemoteConnection, reason: string) => void} close
 */

module.exports = {};
