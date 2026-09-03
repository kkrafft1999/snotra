const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createLlmConfigStorePort,
  createUiPrefsStorePort,
  createChatHistoryStorePort,
  createWorkspaceFolderStorePort,
} = require('../src/main/adapters/persistence-store-adapters');
const { createProviderSecretsPort } = require('../src/main/adapters/provider-secrets-adapter');
const { createCredentialAdapter } = require('../src/main/adapters/credential-adapter');
const { createSkillsAdapter } = require('../src/main/adapters/skills-adapter');

const LLM_CONFIG_STORE_KEYS = [
  'normalizePresetEntry',
  'readLLMConfig',
  'resolveChatModelTarget',
  'updateLLMConfig',
  'writeLLMConfig',
];

const UI_PREFS_STORE_KEYS = ['readUIPrefs', 'updateUIPrefs'];

const CHAT_HISTORY_STORE_KEYS = [
  'MAX_CHAT_SESSIONS',
  'normalizeSessionForLoad',
  'normalizeSessionForStore',
  'normalizeWorkspaceRoot',
  'readChatHistoryStore',
  'sessionMatchesWorkspace',
  'withChatHistoryLock',
  'workspaceBucketKey',
  'writeChatHistoryStore',
];

const WORKSPACE_FOLDER_STORE_KEYS = [
  'getValidatedFolderHistory',
  'getValidatedLastFolder',
  'persistLastFolder',
  'removeFolderFromHistory',
];

const PROVIDER_SECRETS_KEYS = ['getEffectiveProviderConfig'];

const CREDENTIAL_PORT_KEYS = ['getApiKey'];

const SKILL_PORT_KEYS = ['getActiveSkills'];

function makeStorageStub() {
  return {
    readLLMConfig: async () => ({}),
    writeLLMConfig: async () => {},
    updateLLMConfig: async () => ({}),
    resolveChatModelTarget: () => ({}),
    normalizePresetEntry: () => null,
    getEffectiveProviderConfig: async () => null,
    readUIPrefs: async () => ({}),
    updateUIPrefs: async () => ({}),
    MAX_CHAT_SESSIONS: 3,
    readChatHistoryStore: async () => ({ sessions: [], activeByWorkspace: {} }),
    writeChatHistoryStore: async () => {},
    withChatHistoryLock: async (fn) => fn(),
    normalizeSessionForStore: () => null,
    normalizeSessionForLoad: () => null,
    normalizeWorkspaceRoot: () => null,
    workspaceBucketKey: () => '__none__',
    sessionMatchesWorkspace: () => true,
    getValidatedLastFolder: async () => null,
    persistLastFolder: async () => {},
    getValidatedFolderHistory: async () => [],
    removeFolderFromHistory: async () => false,
    leakInternalMethod: async () => 'must-not-forward',
  };
}

test('persistence adapters expose only allowed keys', () => {
  const storage = makeStorageStub();
  assert.deepEqual(Object.keys(createLlmConfigStorePort(storage)).sort(), LLM_CONFIG_STORE_KEYS.sort());
  assert.deepEqual(Object.keys(createUiPrefsStorePort(storage)).sort(), UI_PREFS_STORE_KEYS.sort());
  assert.deepEqual(Object.keys(createChatHistoryStorePort(storage)).sort(), CHAT_HISTORY_STORE_KEYS.sort());
  assert.deepEqual(
    Object.keys(createWorkspaceFolderStorePort(storage)).sort(),
    WORKSPACE_FOLDER_STORE_KEYS.sort()
  );
  assert.deepEqual(Object.keys(createProviderSecretsPort(storage)).sort(), PROVIDER_SECRETS_KEYS.sort());
});

test('credential adapter exposes only getApiKey and uses provider secrets', async () => {
  let seenProviderId = null;
  const providerSecrets = {
    getEffectiveProviderConfig: async (providerId) => {
      seenProviderId = providerId;
      return { apiKey: 'sk-test' };
    },
    leak: () => 'nope',
  };
  const credentials = createCredentialAdapter({ providerSecrets });
  assert.deepEqual(Object.keys(credentials).sort(), CREDENTIAL_PORT_KEYS.sort());
  assert.equal(await credentials.getApiKey('openai'), 'sk-test');
  assert.equal(seenProviderId, 'openai');
});

test('skills adapter exposes only the skill port surface', () => {
  const calls = [];
  const adapter = createSkillsAdapter({
    listCatalog: async () => ({ skills: [] }),
    reload: () => calls.push('reload'),
    getActiveSkills: async (options) => {
      calls.push(options);
      return [];
    },
  });

  assert.deepEqual(Object.keys(adapter).sort(), SKILL_PORT_KEYS);
  return adapter.getActiveSkills({ workspaceRoot: null, activeSkills: ['x'] }).then(() => {
    assert.deepEqual(calls, [{ workspaceRoot: null, activeSkills: ['x'] }]);
  });
});
