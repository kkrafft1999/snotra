const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { removeTempDir } = require('./helpers/temp-dir');

const STORAGE_SERVICE_PATH = path.join(__dirname, '..', 'src', 'main', 'services', 'storage-service.js');

function extractRequires(source) {
  const matches = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

test('storage-service does not import the provider runtime registry', () => {
  const source = fs.readFileSync(STORAGE_SERVICE_PATH, 'utf8');
  const requires = extractRequires(source);
  const forbidden = requires.filter((req) =>
    req === '../providers'
    || req === './providers'
    || req.endsWith('/providers')
    || req.endsWith('/providers/index')
  );
  assert.deepEqual(
    forbidden,
    [],
    `storage-service must depend on ProviderCatalogPort only, found: ${forbidden.join(', ')}`
  );
  assert.match(source, /providerCatalog/, 'storage-service should accept providerCatalog');
  assert.doesNotMatch(source, /getOpenAIApiKey/, 'storage-service must not expose OpenAI-specific credential helpers');
});

test('persistence store adapters expose only narrow store surfaces', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'adapters', 'persistence-store-adapters.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /readLastFolderRaw|writeJsonAtomic|withFileLock/);
  assert.match(source, /createLlmConfigStorePort/);
  assert.match(source, /createChatHistoryStorePort/);
});

test('credential adapter delegates only through provider secrets port', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'adapters', 'credential-adapter.js'),
    'utf8'
  );
  assert.match(source, /providerSecrets/);
  assert.match(source, /getEffectiveProviderConfig/);
  assert.doesNotMatch(source, /llmConfigStore/);
  assert.doesNotMatch(source, /openai|getOpenAIApiKey/i);
});

test('llm config store port does not expose decrypted provider secrets', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'adapters', 'persistence-store-adapters.js'),
    'utf8'
  );
  const llmBlock = source.slice(
    source.indexOf('function createLlmConfigStorePort'),
    source.indexOf('function createUiPrefsStorePort')
  );
  assert.doesNotMatch(llmBlock, /getEffectiveProviderConfig/);
});

test('mcp config store port does not expose decrypted env values', () => {
  // Issue #108: Was der Renderer erreichen kann, darf nicht entschluesseln
  // koennen. Dieselbe Trennung wie beim LLM-Config-Store.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'adapters', 'persistence-store-adapters.js'),
    'utf8'
  );
  const block = source.slice(
    source.indexOf('function createMcpConfigStorePort'),
    source.indexOf('function createMcpSecretsPort')
  );
  assert.doesNotMatch(block, /getMcpServersForRuntime/);
  assert.doesNotMatch(block, /getMcpSecretValues/);
  assert.match(block, /readMcpServers/);
});

test('mcp settings handlers never reach the decrypting port', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'ipc', 'settings-handlers.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /getMcpServersForRuntime|getMcpSecretValues/);
});

test('secret MCP headers never reach the renderer and are masked in a status (#341)', async (t) => {
  const os = require('os');
  const fsp = require('fs/promises');
  const { createStorageService } = require('../src/main/services/storage-service');
  const { createMcpConfigStorePort, createMcpSecretsPort } = require('../src/main/adapters/persistence-store-adapters');
  const { createOwnSecrets } = require('../src/main/services/own-secrets');
  const { maskMcpStatuses } = require('../src/main/services/mcp-status-masking');
  const { createMockProviderCatalog } = require('./helpers/provider-ports');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snotra-mcp-headers-'));
  t.after(() => removeTempDir(tmpDir));
  const storage = createStorageService({
    userDataPath: tmpDir,
    secretStore: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (buf) => buf.toString('utf8').slice(4),
    },
    fs: fsp,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions: 3,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  const token = 'remote-token-0123456789';
  const saved = await storage.saveMcpServer({
    id: 'remote',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: { value: `Bearer ${token}` } },
  });
  assert.equal(saved.ok, true);

  // What the settings handlers can reach shows the header, not its value.
  const shown = await createMcpConfigStorePort(storage).readMcpServers();
  assert.equal(JSON.stringify(shown).includes(token), false);

  // A server that echoes the bare token — without "Bearer" — is masked.
  const ownSecrets = createOwnSecrets({
    llmConfigStore: { readLLMConfig: async () => ({}) },
    providerSecrets: { getEffectiveProviderConfig: async () => null },
    mcpSecrets: createMcpSecretsPort(storage),
    webSearchStore: { getWebSearchApiKey: async () => '' },
  });
  const [masked] = maskMcpStatuses(
    [{ serverId: 'remote', error: { key: 'mcp.http.statusDetail', params: { detail: `bad token ${token}` } }, stderr: `{"error":"${token}"}` }],
    await ownSecrets.readMcpSecrets(),
  );
  assert.equal(JSON.stringify(masked).includes(token), false);
  assert.ok((await ownSecrets.readOwnSecrets()).includes(token), 'the token is one of the own secrets');
});
