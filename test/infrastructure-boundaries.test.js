const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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
