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
 * @typedef {import('../../shared/contracts/message').Message} Message
 * @typedef {Error & { stderr: string, userMessage?: Message, sessionExpired?: boolean }} TransportError
 *
 * Why a connection ended, for both channels (#338).
 * @typedef {{ text: string, message: string | Message }} ExitReason
 *
 * What a transport tells the listener of `onExit`.
 * @typedef {Object} McpTransportExit
 * @property {string} reason
 * @property {string | Message} [reasonMessage]
 * @property {string} stderr
 * @property {boolean} expected  the service closed it
 * @property {boolean} [sessionExpired]  a remote server forgot the session; not a failure
 *
 * @typedef {Object} McpRequestOptions
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 *
 * A request the server sends to us, answered by `onRequest`: `{ result }`, or
 * `null` for "not supported".
 * @typedef {(method: string, params: unknown) => ({ result: unknown } | null)} McpOnRequest
 * @typedef {(request: { id: number, method: string, reason: string }) => void} McpOnCancel
 *
 * One JSON-RPC message, as far as a transport reads it.
 * @typedef {Object} JsonRpcMessage
 * @property {unknown} [id]
 * @property {unknown} [method]
 * @property {unknown} [params]
 * @property {unknown} [result]
 * @property {unknown} [error]
 *
 * What the service gets of a connection; both transports offer it.
 * @typedef {Object} McpTransport
 * @property {() => Promise<void>} start
 * @property {(method: string, params?: unknown, options?: McpRequestOptions) => Promise<unknown>} request  resolves with `result`
 * @property {(method: string, params?: unknown) => void} notify
 * @property {() => Promise<void>} close
 * @property {() => void} kill
 * @property {() => string} stderrText
 * @property {() => boolean} isAlive
 * @property {(listener: (exit: McpTransportExit) => void) => void} onExit
 *
 * What `createTransport` receives from the service.
 * @typedef {Object} McpTransportDeps
 * @property {import('../../shared/contracts/mcp').McpServerConfig} config
 * @property {typeof import('child_process').spawn} spawn
 * @property {NodeJS.ProcessEnv} [baseEnv]  the environment with the PATH of the login shell
 * @property {string} [platform]
 * @property {typeof fetch} [fetch]  for the HTTP transport
 * @property {{ HANDSHAKE_MS?: number, REQUEST_MS?: number, SHUTDOWN_MS?: number }} [timeouts]
 * @property {McpOnRequest} [onRequest]
 * @property {McpOnCancel} [onCancel]
 */

/**
 * A transport error is read on two channels (#338): a failed `tools/call`
 * hands `message` to the model, which reads English, while a failed start or
 * handshake ends up in the MCP status in Settings, which follows the interface
 * language. So each error carries both — the English sentence as `message`,
 * the catalogue message as `userMessage`.
 *
 * @param {string} message
 * @param {string|undefined} stderr
 * @param {Message} [userMessage]
 * @returns {TransportError}
 */
function transportError(message, stderr, userMessage) {
  return Object.assign(new Error(message), {
    stderr: stderr || '',
    ...(userMessage ? { userMessage } : {}),
  });
}

/**
 * A third-party error text, or "unknown error" in the channel's language.
 * @param {{ message?: unknown } | null | undefined} error
 * @returns {{ text: string, message: string | Message }}
 */
function detailOf(error) {
  const text = typeof error?.message === 'string' ? error.message.trim() : '';
  return text
    ? { text, message: text }
    : { text: 'unknown error', message: createMessage('mcp.transport.unknownError') };
}

/**
 * The `error` member of a JSON-RPC answer, as a transport error.
 * @param {{ message?: unknown, code?: unknown } | null | undefined} rpcError
 * @param {string|undefined} stderr
 */
function serverErrorOf(rpcError, stderr) {
  const detail = detailOf(rpcError);
  const code = typeof rpcError?.code === 'number' && Number.isFinite(rpcError.code) ? rpcError.code : null;
  return transportError(
    `The MCP server reports: ${detail.text}${code === null ? '' : ` (code ${code})`}`,
    stderr,
    code === null
      ? createMessage('mcp.transport.serverError', { detail: detail.message })
      : createMessage('mcp.transport.serverErrorCode', { detail: detail.message, code }),
  );
}

module.exports = { transportError, detailOf, serverErrorOf };
