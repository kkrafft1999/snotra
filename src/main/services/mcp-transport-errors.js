'use strict';

/**
 * What the MCP transports share (#106, #341): how an error is built, and what
 * a transport offers the service.
 *
 * A transport — stdio or Streamable HTTP — is an object with
 *
 *   start()                          connects, or throws with plain text
 *   request(method, params, opts)    a JSON-RPC request; resolves with `result`
 *   notify(method, params)           a notification, no answer
 *   close()                          friendly shutdown, resolves when done
 *   kill()                           immediate, synchronous shutdown (app end)
 *   stderrText()                     what explains a failure: stderr, or the
 *                                    body of a refused HTTP answer
 *   isAlive()                        connected and not ended
 *   onExit(listener)                 told once when the connection ends:
 *                                    `{ reason, reasonMessage, stderr,
 *                                    expected, sessionExpired }`
 *
 * and is built by `createTransport({ config, spawn, baseEnv, platform,
 * onRequest, onCancel, … })`. The service never asks which one it has.
 */

const { createMessage } = require('../../shared/contracts/message');

/**
 * A transport error is read on two channels (#338): a failed `tools/call`
 * hands `message` to the model, which reads English, while a failed start or
 * handshake ends up in the MCP status in Settings, which follows the interface
 * language. So each error carries both — the English sentence as `message`,
 * the catalogue message as `userMessage`.
 */
function transportError(message, stderr, userMessage) {
  const error = new Error(message);
  error.stderr = stderr || '';
  if (userMessage) error.userMessage = userMessage;
  return error;
}

/** A third-party error text, or "unknown error" in the channel's language. */
function detailOf(error) {
  const text = typeof error?.message === 'string' ? error.message.trim() : '';
  return text
    ? { text, message: text }
    : { text: 'unknown error', message: createMessage('mcp.transport.unknownError') };
}

/** The `error` member of a JSON-RPC answer, as a transport error. */
function serverErrorOf(rpcError, stderr) {
  const detail = detailOf(rpcError);
  const code = Number.isFinite(rpcError?.code) ? rpcError.code : null;
  return transportError(
    `The MCP server reports: ${detail.text}${code === null ? '' : ` (code ${code})`}`,
    stderr,
    code === null
      ? createMessage('mcp.transport.serverError', { detail: detail.message })
      : createMessage('mcp.transport.serverErrorCode', { detail: detail.message, code }),
  );
}

module.exports = { transportError, detailOf, serverErrorOf };
