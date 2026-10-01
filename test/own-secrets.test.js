'use strict';

// Snotra's own secrets (security concept §5, #505): what the tool adapter
// withholds and the MCP status masks. Until #505 the collection was only
// tested indirectly, with secrets the tests injected.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  secretForms,
  extraHeaderSecretValues,
  expandSecrets,
  createOwnSecrets,
} = require('../src/main/services/own-secrets');
const { containsOwnSecret, redactOwnSecrets, MASK_TEXT } = require('../src/shared/runtime/sensitive-content');

test('secretForms lists the bare token of a value with an auth scheme next to the full value', () => {
  assert.deepEqual(secretForms('Bearer abcdefgh12345678'), ['Bearer abcdefgh12345678', 'abcdefgh12345678']);
  assert.deepEqual(secretForms('  Basic dXNlcjpwYXNzd29yZA==  '), ['Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA==']);
  assert.deepEqual(secretForms('Token tok_1234567890'), ['Token tok_1234567890', 'tok_1234567890']);
  assert.deepEqual(secretForms('sk-plain-key-123456'), ['sk-plain-key-123456']);
});

test('secretForms keeps the minimum length of 8 for the value and for the token', () => {
  assert.deepEqual(secretForms('short'), []);
  assert.deepEqual(secretForms('Bearer abc123'), ['Bearer abc123'], 'a token under 8 characters is no secret of its own');
  assert.deepEqual(secretForms(''), []);
  assert.deepEqual(secretForms(null), []);
  assert.deepEqual(secretForms(42), []);
});

test('secretForms does not split a value of several words', () => {
  assert.deepEqual(secretForms('Mozilla/5.0 (Macintosh) Snotra'), ['Mozilla/5.0 (Macintosh) Snotra']);
});

test('extraHeaderSecretValues takes the values of the lines, never the header names', () => {
  assert.deepEqual(
    extraHeaderSecretValues('cf-aig-authorization: Bearer abcdefgh12345678\r\nX-Env: dev\nX-Tenant: tenant-0815-abc\nno separator here'),
    ['Bearer abcdefgh12345678', 'abcdefgh12345678', 'tenant-0815-abc'],
  );
  assert.deepEqual(extraHeaderSecretValues(''), []);
  assert.deepEqual(extraHeaderSecretValues(undefined), []);
});

test('expandSecrets lists every form once', () => {
  assert.deepEqual(
    expandSecrets(['Bearer abcdefgh12345678', 'abcdefgh12345678', 'tiny', null]),
    ['Bearer abcdefgh12345678', 'abcdefgh12345678'],
  );
});

function makeStores({ providers = {}, presets = [], effective = {}, mcp = [], webSearchKey = null } = {}) {
  return {
    llmConfigStore: { readLLMConfig: async () => ({ providers, presets }) },
    providerSecrets: {
      getEffectiveProviderConfig: async (providerId, options) =>
        effective[options?.presetId ? `${providerId}/${options.presetId}` : providerId] || null,
    },
    mcpSecrets: { getMcpSecretValues: async () => mcp },
    webSearchStore: { getWebSearchApiKey: async () => webSearchKey },
  };
}

test('readOwnSecrets collects provider keys, gateway headers, MCP secrets and the web search key', async () => {
  const { readOwnSecrets } = createOwnSecrets(makeStores({
    providers: { openai: {}, anthropic: {} },
    presets: [
      { id: 'gw', providerId: 'openai-compatible', connection: { baseUrl: 'https://gateway.test' } },
      { id: 'plain', providerId: 'openai' },
    ],
    effective: {
      openai: { apiKey: 'sk-openai-key-123456' },
      anthropic: { apiKey: '' },
      'openai-compatible/gw': { apiKey: 'sk-gateway-key-1234', extraHeaders: 'X-Gateway-Auth: Bearer abcdefgh12345678' },
      'openai/plain': { apiKey: 'must-not-be-read' },
    },
    mcp: ['ghp_mcp_token_1234567'],
    webSearchKey: 'tvly-web-search-key-123',
  }));

  assert.deepEqual((await readOwnSecrets()).sort(), [
    'Bearer abcdefgh12345678',
    'abcdefgh12345678',
    'ghp_mcp_token_1234567',
    'sk-gateway-key-1234',
    'sk-openai-key-123456',
    'tvly-web-search-key-123',
  ].sort());
});

test('readOwnSecrets works without any configured secret', async () => {
  const { readOwnSecrets, readMcpSecrets } = createOwnSecrets(makeStores());
  assert.deepEqual(await readOwnSecrets(), []);
  assert.deepEqual(await readMcpSecrets(), []);
});

test('the bare gateway token and the web search key are withheld in a tool result (#505)', async () => {
  const { readOwnSecrets } = createOwnSecrets(makeStores({
    providers: { 'openai-compatible': {} },
    effective: { 'openai-compatible': { extraHeaders: 'X-Gateway-Auth: Bearer abcdefgh12345678' } },
    webSearchKey: 'tvly-web-search-key-123',
  }));
  const secrets = await readOwnSecrets();

  assert.equal(containsOwnSecret('GATEWAY_TOKEN=abcdefgh12345678', secrets), true);
  assert.equal(containsOwnSecret('TAVILY_API_KEY=tvly-web-search-key-123', secrets), true);
  assert.equal(containsOwnSecret('nothing to see here', secrets), false);
});

test('readMcpSecrets gives the MCP secrets in all their forms, for masking', async () => {
  const { readMcpSecrets } = createOwnSecrets(makeStores({ mcp: ['Bearer mcp-token-12345678'] }));
  const secrets = await readMcpSecrets();
  assert.deepEqual(secrets, ['Bearer mcp-token-12345678', 'mcp-token-12345678']);
  assert.equal(redactOwnSecrets('AUTH=mcp-token-12345678', secrets), `AUTH=${MASK_TEXT}`);
});
