'use strict';

/**
 * What stands behind the channel's message-layer port until the dispatcher
 * of `docs/remote-interface.md` §10 step 1 exists (#1194): every request is
 * answered with `unavailable`, and `session.hello` offers no method beyond
 * `session.bye`. Decided on #1192 (2026-10-20): the channel can then be built
 * and proven end to end, and the dispatcher plugs into the same port later
 * without the channel changing.
 */

const { remoteRpcError } = require('../../shared/contracts/remote/rpc-errors');

/** The limits `session.hello` names (remote-interface.md §8.1), as far as the relay channel has them. */
const STAND_IN_LIMITS = Object.freeze({
  maxRequestBytes: 256 * 1024,
  maxTextChars: 100_000,
  maxConnections: 1,
  eventBufferSeconds: 0,
});

/**
 * @param {{ word: (locale: string, message: import('../../shared/contracts/message').Message) => string }} deps
 * @returns {import('../ports/remote-message-layer-port').RemoteMessageLayerPort}
 */
function createRemoteMessageStandIn({ word }) {
  return {
    describe: () => ({ methods: [], approvalResponses: [], limits: { ...STAND_IN_LIMITS } }),
    open() {},
    handle: async (connection, request) => remoteRpcError(request.id, 'unavailable', (message) => word(connection.locale, message)),
    close() {},
  };
}

module.exports = { createRemoteMessageStandIn, STAND_IN_LIMITS };
