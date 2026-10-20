/**
 * The errors of the remote protocol's message layer (#1192): one shape for
 * everything that goes wrong after dispatch, `docs/remote-interface.md` §6.3.
 *
 * ```
 * error: { code, message, data: { reason, message: { key, params } } }
 * ```
 *
 * `data.message` is a descriptor of `../message.js`, for a client with a
 * catalogue of its own — the phone translates the key. `message` is the same
 * sentence already worded in the connection's language, for a client
 * without one. Never a stack, a secret or a path.
 */
'use strict';

const { createMessage } = require('../message');

/** reason → JSON-RPC code (§6.3). */
const REMOTE_RPC_ERRORS = Object.freeze({
  parse: -32700,
  'invalid-request': -32600,
  'unknown-method': -32601,
  'invalid-params': -32602,
  internal: -32603,
  refused: -32001,
  'not-found': -32002,
  busy: -32003,
  unavailable: -32004,
  'too-large': -32005,
  'rate-limited': -32006,
  'protocol-unsupported': -32010,
  'connection-unknown': -32011,
});

/** @param {string} reason */
function remoteErrorKey(reason) {
  return `remote.rpc.error.${reason}`;
}

/**
 * A JSON-RPC answer that carries an error.
 *
 * @param {string|number|null} id  the request's, or null when it could not be read
 * @param {keyof typeof REMOTE_RPC_ERRORS} reason
 * @param {(message: import('../message').Message) => string} word  the sentence in the connection's language
 * @param {Record<string, unknown>} [extra]  further fields of `data`, e.g. the versions on offer
 */
function remoteRpcError(id, reason, word, extra = {}) {
  const code = REMOTE_RPC_ERRORS[reason] ?? REMOTE_RPC_ERRORS.internal;
  const known = REMOTE_RPC_ERRORS[reason] !== undefined ? reason : 'internal';
  const descriptor = createMessage(remoteErrorKey(known));
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message: word(descriptor), data: { ...extra, reason: known, message: descriptor } },
  };
}

module.exports = { REMOTE_RPC_ERRORS, remoteErrorKey, remoteRpcError };
