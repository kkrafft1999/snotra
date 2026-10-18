'use strict';

/**
 * JSON-RPC 2.0 over Streamable HTTP, the remote transport of the MCP
 * specification (2025-06-18, "Transports") — issue #341.
 *
 * Like the stdio transport, this file knows messages, not the protocol: it
 * sends a request, matches the answer by its `id` and leaves the meaning of
 * `initialize` or `tools/call` to the service. It offers the same interface
 * (see mcp-transport-errors.js), so the service cannot tell the two apart.
 *
 * What the specification asks of a client, and where it happens here:
 *
 * - Every message is a `POST` to the one endpoint, accepting
 *   `application/json` and `text/event-stream`. A request is answered either
 *   with a JSON body or with an SSE stream that carries the answer (and maybe
 *   requests of the server before it); a notification with `202 Accepted`.
 * - The server may hand out a session in `Mcp-Session-Id` on the answer to
 *   `initialize`; every later message carries it, together with the
 *   negotiated `MCP-Protocol-Version`.
 * - A `404` on a known session means the server forgot it. That ends the
 *   connection like a process that exits — but as a restartable end, so the
 *   service runs a fresh `initialize` the next time it needs the server.
 * - Closing sends `DELETE` with the session, so the server can let go of it.
 *
 * Deliberately left out: the optional `GET` stream for messages the server
 * sends on its own (the client declares no capability that would invite
 * any), resuming a broken stream with `Last-Event-ID`, the older HTTP+SSE
 * transport, and OAuth. Static headers carry the credentials.
 *
 * The configured headers go to the configured origin only. Redirects are
 * followed by hand and only on the same origin — never with the token to
 * another host.
 */

const { MCP_LIMITS, MCP_TIMEOUTS } = require('../../shared/contracts/mcp');
const { createMessage } = require('../../shared/contracts/message');
const { transportError, detailOf, serverErrorOf } = require('./mcp-transport-errors');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Error codes of a failed TLS handshake, as Node and OpenSSL name them. */
const TLS_ERROR_CODE = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$|EPROTO$)/;
const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME']);
const CONNECT_TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT']);

/** A session ID is visible ASCII only (specification, "Session Management"). */
const SESSION_ID_PATTERN = /^[\x21-\x7e]+$/;

/** The `code` of a network error, wherever in the `cause` chain it sits. */
function errorCodeOf(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === 'string' && current.code) return current.code;
    current = current.cause;
  }
  return '';
}

function mediaTypeOf(response) {
  return String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

/** A JSON-RPC body may be one message or a batch of them. */
function messagesOf(parsed) {
  if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === 'object');
  return parsed && typeof parsed === 'object' ? [parsed] : [];
}

/**
 * @param {Object} deps
 * @param {import('../../shared/contracts/mcp').McpServerConfig} deps.config
 *   a remote server: `url` and flat `headers`, decrypted
 * @param {typeof fetch} [deps.fetch]
 * @param {(method: string, params: unknown) => ({ result: unknown } | null)} [deps.onRequest]
 *   answers a request the server sends; `null` means "not supported"
 * @param {(request: { id: number, method: string, reason: string }) => void} [deps.onCancel]
 *   told when a request is given up — aborted or timed out
 * @param {{ SHUTDOWN_MS: number }} [deps.timeouts]
 */
function createHttpTransport({
  config,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  onRequest = () => null,
  onCancel = () => {},
  timeouts = MCP_TIMEOUTS,
}) {
  const limits = { ...MCP_TIMEOUTS, ...timeouts };
  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  const pending = new Map();
  /** Every running fetch, so closing can stop them all. */
  const inflight = new Set();
  const exitListeners = new Set();
  // The endpoint as configured, then as a same-origin redirect moved it.
  let endpoint = config.url;
  let origin = '';
  let host = '';
  let sessionId = '';
  let protocolVersion = '';
  let started = false;
  let closing = false;
  let exited = false;
  let nextId = 1;
  // What explains the last refusal: the start of the body the server sent
  // with it. Shown under the status like a process's stderr.
  let excerpt = '';

  function stderrText() {
    return excerpt;
  }

  function fail(message, key, params, stderr = excerpt) {
    return transportError(message, stderr, createMessage(key, { label: config.label, ...params }));
  }

  function failPending(error) {
    const open = [...pending.values()];
    pending.clear();
    for (const entry of open) entry.reject(error);
  }

  function abortInflight() {
    for (const controller of inflight) controller.abort();
    inflight.clear();
  }

  /**
   * The connection is over. `sessionExpired` marks the one end that is not a
   * failure: the server forgot the session, and a fresh `initialize` gets a
   * new one.
   */
  function handleExit(reason, { sessionExpired = false } = {}) {
    if (exited) return;
    exited = true;
    // A remote connection only ends by a close or a forgotten session.
    failPending(sessionExpired && !closing
      ? sessionExpiredError()
      : transportError(
        'The MCP server was stopped while the request was running.',
        excerpt,
        createMessage('mcp.transport.stoppedDuringRequest'),
      ));
    abortInflight();
    for (const listener of exitListeners) {
      try {
        listener({
          reason: reason.text,
          reasonMessage: reason.message,
          stderr: excerpt,
          expected: closing,
          sessionExpired,
        });
      } catch { /* egal */ }
    }
    exitListeners.clear();
  }

  function sessionExpiredError() {
    const error = fail(
      `The MCP server “${config.label}” no longer knows the session; it has to be started again.`,
      'mcp.http.sessionExpired',
    );
    error.sessionExpired = true;
    return error;
  }

  /** What a fetch that never got an answer says about the network. */
  function networkError(error) {
    const code = errorCodeOf(error);
    if (TLS_ERROR_CODE.test(code)) {
      return fail(
        `The secure connection to ${host} failed (${code}). The certificate may be self-signed, expired or issued for another name.`,
        'mcp.http.tls',
        { host, detail: code },
      );
    }
    if (DNS_ERROR_CODES.has(code)) {
      return fail(`The host ${host} was not found.`, 'mcp.http.dns', { host });
    }
    if (code === 'ECONNREFUSED') {
      return fail(`${host} refused the connection — no server is listening there.`, 'mcp.http.refused', { host });
    }
    if (CONNECT_TIMEOUT_CODES.has(code)) {
      return fail(`${host} could not be reached in time.`, 'mcp.http.connectTimeout', { host });
    }
    const detail = code || detailOf(error).text;
    return fail(`The request to ${host} failed: ${detail}`, 'mcp.http.network', { host, detail });
  }

  /**
   * The body of a refusal: all of it for reading a JSON-RPC error out of it,
   * its start for the status — and nothing of an HTML page, which explains
   * nothing in a status line.
   */
  async function refusalBody(response) {
    const type = mediaTypeOf(response);
    if (type !== 'application/json' && !type.startsWith('text/plain')) {
      response.body?.cancel?.().catch(() => {});
      return { text: '', shown: '' };
    }
    let text = '';
    try {
      text = await readText(response, MCP_LIMITS.HTTP_ERROR_BODY_MAX_CHARS * 4, { truncate: true });
    } catch { /* nothing to show */ }
    return { text, shown: text.trim().slice(0, MCP_LIMITS.HTTP_ERROR_BODY_MAX_CHARS) };
  }

  /** Reads a body up to a limit; past it either truncates or throws. */
  async function readText(response, maxBytes, { truncate = false } = {}) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          if (truncate) {
            chunks.push(value.subarray(0, value.byteLength - (size - maxBytes)));
            break;
          }
          throw fail(
            `The MCP server “${config.label}” sent an oversized answer.`,
            'mcp.http.oversized',
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * A message from the server, wherever it came from — a JSON body or an SSE
   * event. Same rules as on stdio: a message with a method is the server's
   * own (a notification, or a request that always gets an answer), anything
   * else may answer one of ours.
   */
  function handleMessage(message) {
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      if (hasId) answerServerRequest(message);
      return;
    }
    if (!hasId) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.error) {
      entry.reject(serverErrorOf(message.error, excerpt));
      return;
    }
    entry.resolve(message.result === undefined ? {} : message.result);
  }

  function answerServerRequest(message) {
    let answer = null;
    try {
      answer = onRequest(message.method, message.params);
    } catch { /* counts as not supported */ }
    const reply = answer && Object.prototype.hasOwnProperty.call(answer, 'result')
      ? { jsonrpc: '2.0', id: message.id, result: answer.result }
      : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    sendWithoutAnswer(reply);
  }

  function dispatchText(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    for (const message of messagesOf(parsed)) handleMessage(message);
    return true;
  }

  /**
   * Reads an SSE stream until `isDone` says the answer we wait for is in.
   * Only `data` lines matter: each event carries one JSON-RPC message (or a
   * batch). Event names, IDs and retry hints are for resuming, which this
   * client does not do.
   */
  async function readEventStream(response, isDone) {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let data = [];
    try {
      while (!isDone()) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MCP_LIMITS.MAX_MESSAGE_BYTES) {
          throw fail(`The MCP server “${config.label}” sent an oversized answer.`, 'mcp.http.oversized');
        }
        for (;;) {
          const match = /\r\n|\r|\n/.exec(buffer);
          // A lone "\r" at the end may be the first half of "\r\n".
          if (!match || (match[0] === '\r' && match.index === buffer.length - 1)) break;
          const line = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (line === '') {
            if (data.length > 0) dispatchText(data.join('\n'));
            data = [];
            if (isDone()) return;
            continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          if (field !== 'data') continue;
          const rest = colon === -1 ? '' : line.slice(colon + 1);
          data.push(rest.startsWith(' ') ? rest.slice(1) : rest);
        }
      }
    } finally {
      // Our answer is in, or we gave up: the rest of the stream is not ours
      // to wait for, and cancelling lets the server close it.
      reader.cancel().catch(() => {});
    }
  }

  function headersFor(method) {
    const headers = method === 'POST'
      ? { ...config.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
      : { ...config.headers };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    return headers;
  }

  /**
   * One HTTP exchange, redirects included. Only same-origin redirects are
   * followed, and by hand: `fetch` would carry the configured headers along
   * to wherever the server points.
   */
  async function exchange(method, body, signal) {
    let target = endpoint;
    for (let hop = 0; hop <= MCP_LIMITS.MAX_REDIRECTS; hop += 1) {
      let response;
      try {
        response = await fetchImpl(target, {
          method,
          headers: headersFor(method),
          body,
          signal,
          redirect: 'manual',
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw networkError(error);
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (target !== endpoint) endpoint = target;
        return response;
      }
      response.body?.cancel?.().catch(() => {});
      let next;
      try {
        next = new URL(response.headers.get('location') || '', target);
      } catch {
        next = null;
      }
      if (!next || next.origin !== origin) {
        throw fail(
          `The MCP server “${config.label}” redirects to another address (${next ? next.origin : 'none'}). Its headers are only sent to ${origin}.`,
          'mcp.http.redirectOtherOrigin',
          { origin: next ? next.origin : '—', configured: origin },
        );
      }
      target = next.href;
    }
    throw fail(`The MCP server “${config.label}” redirects too often.`, 'mcp.http.tooManyRedirects');
  }

  /**
   * The endpoint as an error quotes it: without its query, which some
   * services use for a key — the model reads these sentences too.
   */
  function quotedEndpoint() {
    try {
      const url = new URL(endpoint);
      return `${url.origin}${url.pathname}`;
    } catch {
      return host;
    }
  }

  /** A refused answer, in words a user can act on. */
  async function refusal(response) {
    const { status } = response;
    if (status === 404 && sessionId) {
      response.body?.cancel?.().catch(() => {});
      const error = sessionExpiredError();
      handleExit({ text: 'session expired', message: createMessage('mcp.http.reason.sessionExpired') }, { sessionExpired: true });
      return error;
    }
    const challenge = String(response.headers.get('www-authenticate') || '');
    const { text: body, shown } = await refusalBody(response);
    excerpt = shown;
    const refuse = (message, key, params) => fail(message, key, params, shown);
    if (status === 401) {
      // A server that points at authorization metadata wants an OAuth
      // sign-in (MCP authorization spec), which this client does not do.
      return /resource_metadata/i.test(challenge)
        ? refuse(
          `The MCP server “${config.label}” asks for an OAuth sign-in (401), which is not supported. Use an API key or token in a header instead.`,
          'mcp.http.oauthRequired',
        )
        : refuse(
          `The MCP server “${config.label}” refused the request: not authorised (401). The token in the headers is missing, wrong or expired.`,
          'mcp.http.unauthorized',
        );
    }
    if (status === 403) {
      return refuse(
        `The MCP server “${config.label}” refused access (403).`,
        'mcp.http.forbidden',
      );
    }
    if (status === 404) {
      return refuse(`There is no MCP endpoint at ${quotedEndpoint()} (404).`, 'mcp.http.notFound', { url: quotedEndpoint() });
    }
    if (status === 405) {
      return refuse(
        `${quotedEndpoint()} does not accept MCP requests (405). It may be an older HTTP+SSE server, which is not supported.`,
        'mcp.http.methodNotAllowed',
        { url: quotedEndpoint() },
      );
    }
    // A server that explains itself in JSON-RPC — a wrong protocol version,
    // a missing session — is quoted.
    let rpcError = null;
    try {
      rpcError = messagesOf(JSON.parse(body)).find((message) => message.error)?.error || null;
    } catch { /* not JSON */ }
    if (rpcError) {
      const detail = detailOf(rpcError);
      return refuse(
        `The MCP server “${config.label}” answered with HTTP ${status}: ${detail.text}`,
        'mcp.http.statusDetail',
        { status, detail: detail.message },
      );
    }
    return refuse(`The MCP server “${config.label}” answered with HTTP ${status}.`, 'mcp.http.status', { status });
  }

  function notMcpError(type) {
    return fail(
      `${quotedEndpoint()} answered, but not as an MCP server (${type || 'no content type'}).`,
      'mcp.http.notMcp',
      { url: quotedEndpoint(), type: type || '—' },
    );
  }

  /**
   * Sends one message. For a request (`expectId`) it reads the answer — a
   * JSON body or an SSE stream — and leaves resolving to `handleMessage`;
   * for anything else the answer is only checked for a refusal.
   */
  async function post(message, signal, expectId = null) {
    const response = await exchange('POST', JSON.stringify(message), signal);
    if (!response.ok) throw await refusal(response);
    // Handed out with the answer to `initialize`; every later message
    // carries it (specification, "Session Management").
    const fresh = response.headers.get('mcp-session-id');
    if (fresh && !sessionId && SESSION_ID_PATTERN.test(fresh)) sessionId = fresh;
    excerpt = '';
    if (expectId === null) {
      response.body?.cancel?.().catch(() => {});
      return;
    }
    const type = mediaTypeOf(response);
    if (type === 'text/event-stream') {
      await readEventStream(response, () => !pending.has(expectId));
      return;
    }
    if (type === 'application/json') {
      const text = await readText(response, MCP_LIMITS.MAX_MESSAGE_BYTES);
      if (!dispatchText(text)) throw notMcpError(type);
      return;
    }
    response.body?.cancel?.().catch(() => {});
    throw notMcpError(type);
  }

  /** A message that needs no answer: a notification, or our reply to the server. */
  function sendWithoutAnswer(message) {
    if (!started || exited) return;
    const controller = new AbortController();
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), limits.REQUEST_MS);
    post(message, controller.signal)
      .catch(() => { /* a notification is a courtesy; a forgotten session ends the connection anyway */ })
      .finally(() => {
        clearTimeout(timer);
        inflight.delete(controller);
      });
  }

  /** Nothing to start — the first request opens the connection. */
  async function start() {
    if (started) return;
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw fail(`The address of the MCP server “${config.label}” is not valid.`, 'mcp.http.urlInvalid');
    }
    origin = parsed.origin;
    host = parsed.host;
    started = true;
  }

  function giveUp(id, method, reason) {
    try { onCancel({ id, method, reason }); } catch { /* only a courtesy to the server */ }
  }

  /**
   * A request with an answer. Time limit and AbortSignal end the waiting and
   * the HTTP exchange, not the session — the next call reuses it.
   */
  function request(method, params, { timeoutMs = limits.REQUEST_MS, signal } = {}) {
    if (!started || exited) {
      return Promise.reject(fail(`The MCP server “${config.label}” is not connected.`, 'mcp.transport.notConnected'));
    }
    if (signal?.aborted) {
      return Promise.reject(transportError('Request cancelled.', '', createMessage('mcp.transport.cancelled')));
    }
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (settle, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pending.delete(id);
        inflight.delete(controller);
        settle(value);
      };
      const onAbort = () => {
        if (settled) return;
        giveUp(id, method, 'The client cancelled the request.');
        finish(reject, transportError('Request cancelled.', '', createMessage('mcp.transport.cancelled')));
        controller.abort();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        const seconds = Math.round(timeoutMs / 1000);
        giveUp(id, method, `No answer within ${timeoutMs} ms.`);
        finish(reject, fail(
          `The MCP server “${config.label}” did not answer “${method}” within ${seconds} s.`,
          'mcp.transport.timeout',
          { method, seconds },
        ));
        controller.abort();
      }, timeoutMs);
      pending.set(id, {
        resolve: (result) => {
          // The header every later message carries (specification,
          // "Protocol Version Header").
          if (method === 'initialize' && typeof result?.protocolVersion === 'string') {
            protocolVersion = result.protocolVersion;
          }
          finish(resolve, result);
        },
        reject: (error) => finish(reject, error),
      });
      inflight.add(controller);
      signal?.addEventListener('abort', onAbort, { once: true });
      post({ jsonrpc: '2.0', id, method, params }, controller.signal, id)
        .then(() => {
          if (!settled) {
            finish(reject, fail(
              `The MCP server “${config.label}” ended its answer to “${method}” without a result.`,
              'mcp.http.noResult',
              { method },
            ));
          }
        })
        .catch((error) => finish(reject, error));
    });
  }

  function notify(method, params) {
    sendWithoutAnswer({ jsonrpc: '2.0', method, params });
  }

  /** Tells the server the session is over. A `405` means it keeps none; fine either way. */
  async function endSession() {
    if (!sessionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.SHUTDOWN_MS);
    try {
      const response = await exchange('DELETE', undefined, controller.signal);
      response.body?.cancel?.().catch(() => {});
    } catch { /* the server forgets it on its own eventually */ } finally {
      clearTimeout(timer);
    }
  }

  async function close() {
    closing = true;
    if (!started || exited) {
      failPending(fail(`The MCP server “${config.label}” is not connected.`, 'mcp.transport.notConnected'));
      return;
    }
    failPending(transportError(
      'The MCP server was stopped while the request was running.',
      excerpt,
      createMessage('mcp.transport.stoppedDuringRequest'),
    ));
    abortInflight();
    await endSession();
    handleExit({ text: 'closed', message: createMessage('mcp.http.reason.closed') });
  }

  /** Immediate, for the app's end: the session is let go without waiting. */
  function kill() {
    closing = true;
    if (!started || exited) return;
    abortInflight();
    endSession().catch(() => {});
    handleExit({ text: 'closed', message: createMessage('mcp.http.reason.closed') });
  }

  return {
    start,
    request,
    notify,
    close,
    kill,
    stderrText,
    isAlive: () => started && !exited,
    onExit: (listener) => { exitListeners.add(listener); },
  };
}

module.exports = { createHttpTransport };
