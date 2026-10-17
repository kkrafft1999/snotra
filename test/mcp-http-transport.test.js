// The Streamable HTTP transport (#341) against a local fake MCP server.
//
// Each test talks real HTTP to test/helpers/fake-mcp-http-server.js, so
// headers, status codes, SSE framing and redirects go through Node's fetch as
// they do in the app. Only the TLS and DNS cases stub `fetch`: a failing
// handshake or lookup cannot be staged on a loopback server.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHttpTransport } = require('../src/main/services/mcp-http-transport');
const { startFakeMcpHttpServer } = require('./helpers/fake-mcp-http-server');

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } };

async function withServer(t, mode) {
  const server = await startFakeMcpHttpServer({ mode });
  t.after(() => server.close());
  return server;
}

function makeTransport(url, extra = {}) {
  return createHttpTransport({
    config: { id: 'remote', label: 'Remote', url, headers: { Authorization: 'Bearer test-token-123' }, ...extra.config },
    ...extra,
  });
}

async function connected(url, extra) {
  const transport = makeTransport(url, extra);
  await transport.start();
  await transport.request('initialize', INIT);
  transport.notify('notifications/initialized', {});
  return transport;
}

test('JSON answers: the session ID and the protocol version ride along after initialize', async (t) => {
  const server = await withServer(t, 'json');
  const transport = await connected(server.url);
  t.after(() => transport.close());

  const list = await transport.request('tools/list', {});
  assert.deepEqual(list.tools.map((tool) => tool.name), ['echo', 'add']);

  const [init] = server.posts('initialize');
  assert.equal(init.headers['mcp-session-id'], undefined, 'initialize opens the session, it carries none');
  assert.equal(init.headers['mcp-protocol-version'], undefined);
  assert.equal(init.headers.authorization, 'Bearer test-token-123');
  assert.match(init.headers.accept, /application\/json/);
  assert.match(init.headers.accept, /text\/event-stream/);

  const [later] = server.posts('tools/list');
  assert.equal(later.headers['mcp-session-id'], 'session-1');
  assert.equal(later.headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(later.headers.authorization, 'Bearer test-token-123');
  assert.equal(server.posts('notifications/initialized').length, 1);
});

test('SSE answers in chunks with CRLF resolve without waiting for the stream to end', async (t) => {
  const server = await withServer(t, 'sse');
  const transport = await connected(server.url);
  t.after(() => transport.close());

  const started = Date.now();
  const result = await transport.request('tools/call', { name: 'echo', arguments: { text: 'hallo' } });
  assert.deepEqual(result.content, [{ type: 'text', text: 'hallo' }]);
  // The fake keeps every stream open for two more seconds.
  assert.ok(Date.now() - started < 1500, 'the answer is used as soon as it is in');
});

test('a request of the server inside the stream is answered, and the result still arrives', async (t) => {
  const server = await withServer(t, 'sse-ping');
  const transport = await connected(server.url, { onRequest: (method) => (method === 'ping' ? { result: {} } : null) });
  t.after(() => transport.close());

  const result = await transport.request('tools/call', { name: 'add', arguments: { a: 2, b: 3 } });
  assert.deepEqual(result.content, [{ type: 'text', text: '5' }]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(server.state.replies, [{ jsonrpc: '2.0', id: 'ping-1', result: {} }]);
});

test('closing sends DELETE with the session and counts as an expected end', async (t) => {
  const server = await withServer(t, 'json');
  const transport = await connected(server.url);
  const exits = [];
  transport.onExit((info) => exits.push(info));

  await transport.close();
  assert.deepEqual(server.state.deleted, ['session-1']);
  assert.equal(transport.isAlive(), false);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].expected, true);
  await assert.rejects(() => transport.request('tools/list', {}), (error) => error.userMessage?.key === 'mcp.transport.notConnected');
});

test('a server without sessions gets no session header and no DELETE', async (t) => {
  const server = await withServer(t, 'no-session');
  const transport = await connected(server.url);
  await transport.request('tools/list', {});
  await transport.close();
  assert.equal(server.posts('tools/list')[0].headers['mcp-session-id'], undefined);
  assert.deepEqual(server.state.deleted, []);
});

test('a 404 on a known session ends the connection as restartable, not as a failure', async (t) => {
  const server = await withServer(t, 'json');
  const transport = await connected(server.url);
  const exits = [];
  transport.onExit((info) => exits.push(info));

  server.expireSessions();
  await assert.rejects(
    () => transport.request('tools/call', { name: 'echo', arguments: { text: 'x' } }),
    (error) => error.sessionExpired === true && error.userMessage?.key === 'mcp.http.sessionExpired',
  );
  assert.equal(transport.isAlive(), false);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].sessionExpired, true);
  assert.equal(exits[0].expected, false);
});

test('refusals come back in words a user can act on', async (t) => {
  const server = await withServer(t, 'json');
  const cases = [
    ['unauthorized', 'mcp.http.unauthorized'],
    ['oauth', 'mcp.http.oauthRequired'],
    ['forbidden', 'mcp.http.forbidden'],
    ['html', 'mcp.http.notMcp'],
    ['not-allowed', 'mcp.http.methodNotAllowed'],
    ['rpc-error-400', 'mcp.http.statusDetail'],
    ['no-result', 'mcp.http.noResult'],
  ];
  for (const [mode, key] of cases) {
    server.setMode(mode);
    const transport = makeTransport(server.url);
    await transport.start();
    await assert.rejects(
      () => transport.request('initialize', INIT),
      (error) => {
        assert.equal(error.userMessage?.key, key, mode);
        assert.equal(error.userMessage.params.label, 'Remote');
        // The model reads the English sentence.
        assert.match(error.message, /\S/);
        return true;
      },
    );
    await transport.close();
  }
});

test('a refusal keeps the start of a text body, but never an HTML page', async (t) => {
  const server = await withServer(t, 'unauthorized');
  const transport = makeTransport(server.url);
  await transport.start();
  await assert.rejects(() => transport.request('initialize', INIT), (error) => /invalid_token/.test(error.stderr));
  server.setMode('html');
  await assert.rejects(() => transport.request('initialize', INIT), (error) => error.stderr === '');
  server.setMode('rpc-error-400');
  await assert.rejects(
    () => transport.request('initialize', INIT),
    (error) => error.userMessage.params.detail === 'Unsupported protocol version' && error.userMessage.params.status === 400,
  );
});

test('a timeout gives up the request, tells the server and keeps the session', async (t) => {
  const server = await withServer(t, 'slow-call');
  const cancelled = [];
  const transport = await connected(server.url, { onCancel: (request) => cancelled.push(request) });
  t.after(() => transport.close());

  await assert.rejects(
    () => transport.request('tools/call', { name: 'echo', arguments: {} }, { timeoutMs: 200 }),
    (error) => error.userMessage?.key === 'mcp.transport.timeout' && error.userMessage.params.method === 'tools/call',
  );
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].method, 'tools/call');
  assert.equal(transport.isAlive(), true);
  server.setMode('json');
  const list = await transport.request('tools/list', {});
  assert.equal(list.tools.length, 2);
});

test('an AbortSignal cancels the request', async (t) => {
  const server = await withServer(t, 'slow-call');
  const transport = await connected(server.url);
  t.after(() => transport.close());
  const controller = new AbortController();
  const pending = transport.request('tools/call', { name: 'echo' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error.userMessage?.key === 'mcp.transport.cancelled');
});

test('a same-origin redirect is followed with the headers; later requests go straight there', async (t) => {
  const server = await withServer(t, 'redirect-same');
  const transport = await connected(server.url);
  t.after(() => transport.close());
  await transport.request('tools/call', { name: 'echo', arguments: { text: 'x' } });
  const moved = server.state.requests.filter((request) => request.path === '/mcp-moved');
  assert.ok(moved.length >= 2);
  assert.ok(moved.every((request) => request.headers.authorization === 'Bearer test-token-123'));
  assert.equal(server.state.requests.filter((request) => request.path === '/mcp').length, 1, 'only the first request was redirected');
});

test('a redirect to another origin is refused instead of taking the token along', async (t) => {
  const server = await withServer(t, 'redirect-other');
  const seen = [];
  const transport = makeTransport(server.url, {
    fetch: (url, options) => {
      seen.push(String(url));
      return globalThis.fetch(url, options);
    },
  });
  await transport.start();
  await assert.rejects(
    () => transport.request('initialize', INIT),
    (error) => error.userMessage?.key === 'mcp.http.redirectOtherOrigin',
  );
  assert.deepEqual(seen, [server.url]);
});

test('a port without a server is reported as refused', async (t) => {
  const server = await startFakeMcpHttpServer();
  const { url } = server;
  await server.close();
  const transport = makeTransport(url);
  await transport.start();
  await assert.rejects(
    () => transport.request('initialize', INIT),
    (error) => error.userMessage?.key === 'mcp.http.refused',
  );
});

test('TLS and DNS failures are named, read from the cause of the fetch error', async () => {
  const failing = (code) => async () => {
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error(code), { code });
    throw error;
  };
  const cases = [
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'mcp.http.tls'],
    ['CERT_HAS_EXPIRED', 'mcp.http.tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'mcp.http.tls'],
    ['ENOTFOUND', 'mcp.http.dns'],
    ['UND_ERR_CONNECT_TIMEOUT', 'mcp.http.connectTimeout'],
    ['ECONNRESET', 'mcp.http.network'],
  ];
  for (const [code, key] of cases) {
    const transport = makeTransport('https://mcp.example.com/mcp', { fetch: failing(code) });
    await transport.start();
    await assert.rejects(
      () => transport.request('initialize', INIT),
      (error) => {
        assert.equal(error.userMessage?.key, key, code);
        assert.equal(error.userMessage.params.host, 'mcp.example.com');
        return true;
      },
    );
  }
});

test('the configured headers never appear in an error', async (t) => {
  const server = await withServer(t, 'forbidden');
  const transport = makeTransport(server.url);
  await transport.start();
  await assert.rejects(() => transport.request('initialize', INIT), (error) => {
    assert.doesNotMatch(JSON.stringify({ message: error.message, user: error.userMessage, stderr: error.stderr }), /test-token-123/);
    return true;
  });
});
