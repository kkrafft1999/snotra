'use strict';

/**
 * A real MCP server over Streamable HTTP for the tests of #341 — a local
 * `http` server, not a stubbed `fetch`, so status codes, headers, SSE framing
 * and redirects go through the same stack as in the app.
 *
 * `mode` decides how it behaves (and can be changed while it runs):
 *   json            answers every request with a JSON body (default)
 *   sse             answers every request with an SSE stream, split into
 *                   chunks, with a comment line and CRLF line ends
 *   sse-ping        like sse, but pings the client inside the stream before
 *                   the answer to tools/call
 *   no-session      never hands out a session ID
 *   unauthorized    401 on everything
 *   oauth           401 with a WWW-Authenticate pointing at resource metadata
 *   forbidden       403 on everything
 *   html            200 with an HTML page, as a web server that is no MCP server
 *   not-allowed     405, as an older HTTP+SSE server answers a POST
 *   rpc-error-400   400 with a JSON-RPC error body
 *   slow-call       never answers tools/call
 *   redirect-same   307 to /mcp-moved on the same origin, which then works
 *   redirect-other  307 to another origin
 *   no-result       200 with an SSE stream that ends without the answer
 */

const http = require('node:http');

const TOOLS = [
  { name: 'echo', description: 'Returns the text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];

function startFakeMcpHttpServer({ mode = 'json' } = {}) {
  const state = {
    mode,
    /** Every request: method, path, headers (lower-case), parsed body. */
    requests: [],
    sessions: new Set(),
    deleted: [],
    sessionCounter: 0,
    /** What the client answered to our pings, by id. */
    replies: [],
  };
  const sockets = new Set();

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  function resultFor(message) {
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-http', version: '1.0.0' },
        };
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const args = message.params?.arguments || {};
        if (message.params?.name === 'add') return { content: [{ type: 'text', text: String(args.a + args.b) }] };
        return { content: [{ type: 'text', text: String(args.text ?? '') }] };
      }
      default:
        return null;
    }
  }

  function writeSse(res, events) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': keep-alive\r\n\r\n');
    let delay = 0;
    for (const event of events) {
      const text = `event: message\r\nid: ${Math.random().toString(36).slice(2)}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
      const cut = Math.floor(text.length / 2);
      delay += 5;
      setTimeout(() => res.write(text.slice(0, cut)), delay);
      delay += 5;
      setTimeout(() => res.write(text.slice(cut)), delay);
    }
    return delay;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      state.requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, body });
      const { mode: current } = state;
      const path = req.url;

      if (current === 'redirect-same' && path === '/mcp') {
        res.writeHead(307, { Location: '/mcp-moved' });
        res.end();
        return;
      }
      if (current === 'redirect-other') {
        res.writeHead(307, { Location: 'http://127.0.0.2:9/mcp' });
        res.end();
        return;
      }
      if (current === 'unauthorized') return send(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer' });
      if (current === 'oauth') {
        return send(res, 401, undefined, {
          'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"',
        });
      }
      if (current === 'forbidden') return send(res, 403, { error: 'forbidden' });
      if (current === 'not-allowed') {
        res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }
      if (current === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Welcome</title><p>Hello</p>');
        return;
      }

      const session = req.headers['mcp-session-id'];
      if (req.method === 'DELETE') {
        state.deleted.push(session);
        state.sessions.delete(session);
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (session && !state.sessions.has(session)) {
        send(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
        return;
      }

      const messages = Array.isArray(body) ? body : [body];
      const requests = messages.filter((message) => message && message.method && message.id !== undefined);
      if (requests.length === 0) {
        // Notifications and replies to our pings.
        for (const message of messages) {
          if (message && message.id !== undefined && !message.method) state.replies.push(message);
        }
        res.writeHead(202);
        res.end();
        return;
      }
      const message = requests[0];
      if (current === 'rpc-error-400') {
        send(res, 400, { jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Unsupported protocol version' } });
        return;
      }
      if (current === 'slow-call' && message.method === 'tools/call') return; // never answers

      const headers = {};
      if (message.method === 'initialize' && current !== 'no-session') {
        state.sessionCounter += 1;
        const id = `session-${state.sessionCounter}`;
        state.sessions.add(id);
        headers['Mcp-Session-Id'] = id;
      }
      const result = resultFor(message);
      const answer = result === null
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }
        : { jsonrpc: '2.0', id: message.id, result };

      if (current === 'no-result') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
        res.end(': nothing here\n\n');
        return;
      }
      if (current === 'sse' || current === 'sse-ping' || (current === 'redirect-same' && message.method === 'tools/call')) {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        const events = current === 'sse-ping' && message.method === 'tools/call'
          ? [{ jsonrpc: '2.0', id: 'ping-1', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/progress', params: {} }, answer]
          : [answer];
        const done = writeSse(res, events);
        // A server keeps the stream open a little; the client must not wait for it.
        setTimeout(() => res.end(), done + 2000).unref();
        return;
      }
      send(res, 200, answer, headers);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        origin,
        url: `${origin}/mcp`,
        state,
        setMode(next) { state.mode = next; },
        /** The server forgets every session, as after a restart. */
        expireSessions() { state.sessions.clear(); },
        posts(method) {
          return state.requests.filter((request) => request.method === 'POST' && request.body?.method === method);
        },
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = { startFakeMcpHttpServer, TOOLS };
