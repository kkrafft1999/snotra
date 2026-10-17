// The MCP service with a remote server over Streamable HTTP (#341).
//
// The service picks the transport by the server's `transport`; everything
// above it — namespace, catalogue, calls — must read the same as for stdio.
// The counterpart is the local fake in test/helpers/fake-mcp-http-server.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMcpService } = require('../src/main/services/mcp-service');
const { MCP_CONNECTION_STATES } = require('../src/shared/contracts/mcp');
const { startFakeMcpHttpServer } = require('./helpers/fake-mcp-http-server');

function remote(id, url, extra = {}) {
  return { id, label: id, transport: 'http', url, headers: { Authorization: 'Bearer abc-123-xyz' }, ...extra };
}

async function setup(t, mode = 'json') {
  const fake = await startFakeMcpHttpServer({ mode });
  const service = createMcpService({
    // A remote server must never start a process.
    spawn: () => { throw new Error('spawn must not be called for a remote server'); },
    readShellPath: async () => { throw new Error('a remote server needs no PATH'); },
    timeouts: { HANDSHAKE_MS: 4_000, REQUEST_MS: 4_000 },
  });
  t.after(async () => {
    await service.shutdown();
    await fake.close();
  });
  return { fake, service };
}

function statusOf(service, id) {
  return service.describeConnections().find((s) => s.serverId === id);
}

test('a remote server offers its tools and runs calls like a local one', async (t) => {
  const { fake, service } = await setup(t);
  assert.equal(service.setServers([remote('web', fake.url)]).ok, true);

  const tools = await service.listTools();
  assert.deepEqual(tools.map((tool) => `${tool.serverId}:${tool.name}`), ['web:echo', 'web:add']);
  const status = statusOf(service, 'web');
  assert.equal(status.state, MCP_CONNECTION_STATES.READY);
  assert.equal(status.serverName, 'fake-http');
  assert.equal(status.protocolVersion, '2025-06-18');

  const result = await service.callTool({ serverId: 'web', name: 'add', args: { a: 1, b: 2 } });
  assert.deepEqual(result, { content: [{ type: 'text', text: '3' }], isError: false });
});

test('an expired session is replaced by a fresh initialize, and the call goes through', async (t) => {
  const { fake, service } = await setup(t, 'sse');
  service.setServers([remote('web', fake.url)]);
  await service.listTools();

  fake.expireSessions();
  const result = await service.callTool({ serverId: 'web', name: 'echo', args: { text: 'again' } });
  assert.deepEqual(result.content, [{ type: 'text', text: 'again' }]);
  assert.equal(fake.posts('initialize').length, 2);
  assert.equal(fake.posts('tools/call').at(-1).headers['mcp-session-id'], 'session-2');
  assert.equal(statusOf(service, 'web').state, MCP_CONNECTION_STATES.READY);
});

test('a refused server is failed with an understandable status and stays failed', async (t) => {
  const { fake, service } = await setup(t, 'unauthorized');
  service.setServers([remote('web', fake.url)]);
  assert.deepEqual(await service.listTools(), []);
  const status = statusOf(service, 'web');
  assert.equal(status.state, MCP_CONNECTION_STATES.FAILED);
  assert.equal(status.error.key, 'mcp.http.unauthorized');
  assert.match(status.stderr, /invalid_token/);
  // Not retried by itself — every tool call would knock again otherwise.
  await service.listTools();
  assert.equal(fake.posts('initialize').length, 1);
  await assert.rejects(() => service.callTool({ serverId: 'web', name: 'echo' }), /not authorised \(401\)/);
});

test('testing a switched-off server connects once and lets go again', async (t) => {
  const { fake, service } = await setup(t);
  service.setServers([remote('web', fake.url, { enabled: false })]);

  const status = await service.connect('web');
  assert.equal(status.state, MCP_CONNECTION_STATES.READY);
  assert.deepEqual(status.toolNames, ['echo', 'add']);
  // Closed right after: the session is ended, and no tool reaches the model.
  assert.deepEqual(fake.state.deleted, ['session-1']);
  assert.deepEqual(await service.listTools(), []);
  await assert.rejects(() => service.callTool({ serverId: 'web', name: 'echo' }), /is switched off/);
});

test('a changed address or header reconnects; a changed label does not', async (t) => {
  const { fake, service } = await setup(t);
  service.setServers([remote('web', fake.url)]);
  await service.listTools();

  service.setServers([remote('web', fake.url, { label: 'Renamed' })]);
  await service.listTools();
  assert.equal(fake.posts('initialize').length, 1);

  service.setServers([remote('web', fake.url, { headers: { Authorization: 'Bearer other-token-1' } })]);
  await service.listTools();
  assert.equal(fake.posts('initialize').length, 2);
  assert.equal(fake.posts('initialize').at(-1).headers.authorization, 'Bearer other-token-1');
});
