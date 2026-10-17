'use strict';

// Snotra's own secrets (security concept §5, #505): what the tool adapter
// withholds and the MCP status masks. Until #505 the collection was only
// tested indirectly, with secrets the tests injected.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  secretForms,
  encodedForms,
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
    [
      'Bearer abcdefgh12345678', ...encodedForms('Bearer abcdefgh12345678'),
      'abcdefgh12345678', ...encodedForms('abcdefgh12345678'),
    ],
  );
});

// ---------------------------------------------------------------------------
// Encoded forms (#993): a shell command or a request log that prints a key
// base64- or hex-encoded, or URL-encoded, is withheld like the key itself.

const KEY = 'sk-own-provider-key-1234567890';
// '?' and '>' make the base64 alphabets differ in '/' and '+'.
const KEY_WITH_SYMBOLS = 'sk-key-???->>>-1234567890';

function withheld(text, value = KEY) {
  return containsOwnSecret(text, expandSecrets([value]));
}

test('base64: the encoded key is withheld at every offset and with anything after it', () => {
  // `echo -n "$KEY" | base64`, `echo "$KEY" | base64` and the like.
  assert.equal(withheld(Buffer.from(KEY).toString('base64')), true);
  assert.equal(withheld(Buffer.from(`${KEY}\n`).toString('base64')), true);
  // Embedded in a longer value: the key starts at the first, second or third
  // byte of a 3-byte group — `printf 'user:%s' "$KEY" | base64` is the third.
  for (const prefix of ['', 'a', 'ab', 'abc', 'user:', 'x-api-key: ']) {
    for (const suffix of ['', '\n', ':', '"}']) {
      const encoded = Buffer.from(`${prefix}${KEY}${suffix}`).toString('base64');
      assert.equal(withheld(`token: ${encoded}`), true, `prefix ${JSON.stringify(prefix)}, suffix ${JSON.stringify(suffix)}`);
    }
  }
});

test('base64: wrapped over several lines, as GNU base64 and openssl print it', () => {
  const encoded = Buffer.from(`Authorization: Bearer ${KEY}`).toString('base64');
  const wrapped = encoded.match(/.{1,16}/g).join('\n');
  assert.ok(wrapped.includes('\n'));
  assert.equal(withheld(wrapped), true);
  assert.equal(withheld(wrapped.replace(/\n/g, '\r\n')), true);
  // A tool result reaches the check as JSON, where the line break is `\n`.
  assert.equal(withheld(JSON.stringify({ stdout: wrapped })), true);
});

test('base64url: the URL-safe alphabet and the missing padding are matched too', () => {
  const standard = Buffer.from(KEY_WITH_SYMBOLS).toString('base64');
  const urlSafe = Buffer.from(KEY_WITH_SYMBOLS).toString('base64url');
  assert.notEqual(standard.replace(/=+$/, ''), urlSafe, 'the test key must encode differently in both alphabets');
  assert.equal(withheld(standard, KEY_WITH_SYMBOLS), true);
  assert.equal(withheld(urlSafe, KEY_WITH_SYMBOLS), true);
  for (const prefix of ['a', 'ab']) {
    assert.equal(withheld(Buffer.from(`${prefix}${KEY_WITH_SYMBOLS}`).toString('base64url'), KEY_WITH_SYMBOLS), true);
  }
  // A JWT-like value: header.payload with the key inside the payload.
  const payload = Buffer.from(JSON.stringify({ key: KEY_WITH_SYMBOLS })).toString('base64url');
  assert.equal(withheld(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`, KEY_WITH_SYMBOLS), true);
});

test('hex: lower and upper case, embedded and wrapped as xxd -p prints it', () => {
  const hex = Buffer.from(KEY).toString('hex');
  assert.equal(withheld(hex), true);
  assert.equal(withheld(hex.toUpperCase()), true);
  // Hex keeps every byte apart, so a key inside a longer value is matched at any offset.
  assert.equal(withheld(Buffer.from(`KEY=${KEY}\n`).toString('hex')), true);
  assert.equal(withheld(Buffer.from(`KEY=${KEY}`).toString('hex').match(/.{1,60}/g).join('\n')), true);
  // Fully percent-encoded is hex as well.
  assert.equal(withheld([...Buffer.from(KEY)].map((b) => `%${b.toString(16)}`).join('')), true);
});

test('URL encoding: in either case, partially, and for a value with an auth scheme', () => {
  const value = 'p@ss/w0rd+key=123456';
  assert.equal(withheld(`https://api.test/?key=${encodeURIComponent(value)}`, value), true);
  assert.equal(withheld(`GET /?key=${encodeURIComponent(value).toLowerCase()}`, value), true);
  // Python's quote() keeps the slash; other encoders keep '@' or '+'.
  assert.equal(withheld('key=p%40ss/w0rd%2Bkey%3D123456', value), true);
  assert.equal(withheld('key=p@ss%2Fw0rd+key%3d123456', value), true);
  assert.equal(withheld(`auth=${encodeURIComponent('Bearer abcdefgh12345678')}`, 'Bearer abcdefgh12345678'), true);
});

test('JSON escaping: a value with a quote or a backslash is matched inside a tool result', () => {
  const value = 'pa"ss\\word-123456';
  assert.equal(withheld(JSON.stringify({ stdout: `secret=${value}` }), value), true);
});

test('encodedForms lists only forms that differ from the value and are long enough', () => {
  for (const form of encodedForms('abcdefgh')) {
    assert.ok(form.length >= 10, `${form} is shorter than the base64 of 8 characters`);
  }
  // Letters, digits and '-_.~' need no URL escaping, so no duplicate of the value.
  assert.equal(encodedForms('sk-plain_key.123~').includes('sk-plain_key.123~'), false);
  assert.equal(new Set(encodedForms(KEY)).size, encodedForms(KEY).length);
});

test('no false positives: short values, other data, parts of a key', () => {
  // Values under 8 characters are no secrets, so they have no encoded forms either.
  assert.deepEqual(expandSecrets(['dev', 'abc1234', ' Bearer ']), []);
  assert.equal(containsOwnSecret(Buffer.from('dev').toString('base64'), expandSecrets(['dev'])), false);
  // Ordinary encoded data does not match a key it does not contain.
  const crypto = require('node:crypto');
  const noise = [
    crypto.randomBytes(4096).toString('base64'),
    crypto.randomBytes(4096).toString('base64url'),
    crypto.randomBytes(4096).toString('hex'),
    crypto.createHash('sha256').update(KEY).digest('hex'),
    Buffer.from('sk-own-provider-key-0000000000').toString('base64'),
    Buffer.from('the quick brown fox jumps over the lazy dog').toString('hex'),
    'Progress: 100% done, 50%25 escaped, %zz broken',
  ].join('\n');
  assert.equal(withheld(noise), false);
  assert.equal(withheld(JSON.stringify({ stdout: noise })), false);
  // Half of a key, encoded, is not the key.
  assert.equal(withheld(Buffer.from(KEY.slice(0, 15)).toString('base64')), false);
  assert.equal(withheld(Buffer.from(KEY.slice(0, 15)).toString('hex')), false);
  assert.equal(withheld(encodeURIComponent(KEY.slice(0, 15))), false);
});

test('redactOwnSecrets masks the encoded forms in an MCP server\'s output', async () => {
  const { readMcpSecrets } = createOwnSecrets(makeStores({ mcp: [KEY_WITH_SYMBOLS] }));
  const secrets = await readMcpSecrets();
  for (const encoded of [
    Buffer.from(KEY_WITH_SYMBOLS).toString('hex'),
    encodeURIComponent(KEY_WITH_SYMBOLS),
  ]) {
    assert.equal(redactOwnSecrets(`token=${encoded}`, secrets), `token=${MASK_TEXT}`);
  }
  const base64 = Buffer.from(`Basic user:${KEY_WITH_SYMBOLS}`).toString('base64');
  const masked = redactOwnSecrets(`auth=${base64}`, secrets);
  assert.ok(masked.includes(MASK_TEXT));
  assert.equal(containsOwnSecret(masked, secrets), false, 'nothing of the key is left that the check would find');
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

  const verbatim = [
    'Bearer abcdefgh12345678',
    'abcdefgh12345678',
    'ghp_mcp_token_1234567',
    'sk-gateway-key-1234',
    'sk-openai-key-123456',
    'tvly-web-search-key-123',
  ];
  const secrets = await readOwnSecrets();
  for (const form of verbatim) assert.ok(secrets.includes(form), form);
  // Next to each verbatim form its encodings (#993), and nothing else.
  assert.deepEqual(secrets.sort(), expandSecrets(verbatim).sort());
  assert.equal(secrets.includes('must-not-be-read'), false);
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
  assert.deepEqual(secrets, expandSecrets(['Bearer mcp-token-12345678']));
  assert.deepEqual(secrets.slice(0, 1), ['Bearer mcp-token-12345678']);
  assert.ok(secrets.includes('mcp-token-12345678'));
  assert.equal(redactOwnSecrets('AUTH=mcp-token-12345678', secrets), `AUTH=${MASK_TEXT}`);
});
