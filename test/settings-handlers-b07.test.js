const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { registerSettingsHandlers, mergePresetConnection } = require('../src/main/ipc/settings-handlers');
const { createStorageService } = require('../src/main/services/storage-service');
const {
  createLlmConfigStorePort,
  createUiPrefsStorePort,
  createWorkspaceFolderStorePort,
} = require('../src/main/adapters/persistence-store-adapters');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { createMockIpcMain } = require('./helpers/mock-ipc');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { getProvider } = require('../src/main/providers');
const { createSettingsPresentationService } = require('../src/main/services/settings-presentation-service');

/**
 * Findings of the B07 review on the settings handlers: a stored secret stays
 * bound to its endpoint on saving (#560), and the smaller items of #562.
 */

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
  decryptString(buffer) {
    const text = buffer.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not ours');
    return text.slice(4);
  },
};
const enc = (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8').toString('base64');

const COMPAT = {
  id: 'openai-compatible',
  name: 'OpenAI-compatible',
  defaultModel: '',
  optionalApiKey: true,
  connectionPerPreset: true,
  defaultBaseUrl: 'http://localhost:1234/v1',
  defaultApiStyle: 'chat',
  fields: { apiKey: true, baseUrl: true, insecureTls: true, displayName: true, apiStyle: true, extraHeaders: true },
  presentation: {},
};
// A provider whose connection lives on the provider, with the free-text fields.
const GATEWAY = {
  id: 'gateway',
  name: 'Gateway',
  defaultModel: 'g1',
  fields: { apiKey: true, displayName: true, extraHeaders: true },
  presentation: {},
};
const PROVIDERS = { [COMPAT.id]: COMPAT, [GATEWAY.id]: GATEWAY };

const GOOD = 'http://good.example/v1';
const EVIL = 'http://evil.example/v1';

test('a new address drops the stored key and headers (#560)', () => {
  const previous = { baseUrl: GOOD, apiKeyEnc: enc('key'), extraHeadersEnc: enc('X-GW: hdr') };

  const { connection } = mergePresetConnection({ safeStorage }, { previous, patch: { baseUrl: EVIL }, provider: COMPAT });

  assert.equal(connection.baseUrl, EVIL);
  assert.equal(connection.apiKeyEnc, undefined);
  assert.equal(connection.extraHeadersEnc, undefined);
});

test('the same address, written differently, keeps the stored key and headers (#560)', () => {
  const previous = { baseUrl: GOOD, apiKeyEnc: enc('key'), extraHeadersEnc: enc('X-GW: hdr') };

  const { connection } = mergePresetConnection({ safeStorage }, {
    previous,
    patch: { baseUrl: `  ${GOOD}/  `.trim(), apiStyle: 'full' },
    provider: COMPAT,
  });

  assert.equal(connection.apiKeyEnc, previous.apiKeyEnc);
  assert.equal(connection.extraHeadersEnc, previous.extraHeadersEnc);
  assert.equal(connection.apiStyle, 'full');
});

test('an entry on the default address keeps its key when the draft names that address (#560)', () => {
  const previous = { apiKeyEnc: enc('key') };

  const { connection } = mergePresetConnection({ safeStorage }, {
    previous,
    patch: { baseUrl: COMPAT.defaultBaseUrl },
    provider: COMPAT,
  });

  assert.equal(connection.apiKeyEnc, previous.apiKeyEnc);
});

test('a new address with a new key stores the new key only (#560)', () => {
  const previous = { baseUrl: GOOD, apiKeyEnc: enc('old'), extraHeadersEnc: enc('X-GW: old') };

  const { connection } = mergePresetConnection({ safeStorage }, {
    previous,
    patch: { baseUrl: EVIL, apiKey: 'new' },
    provider: COMPAT,
  });

  assert.equal(connection.apiKeyEnc, enc('new'));
  assert.equal(connection.extraHeadersEnc, undefined);
});

async function setup(t, { onShowHiddenFilesChanged = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-b07-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const providerCatalog = createMockProviderCatalog((id) => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null), {
    listMeta: () => Object.values(PROVIDERS),
  });
  const storage = createStorageService({
    app: { getPath: () => dir },
    safeStorage,
    fs,
    path,
    providerCatalog,
    maxChatSessions: 10,
    maxFolderHistory: 5,
    defaultProviderId: 'gateway',
  });
  const ipcMain = createMockIpcMain();
  const llmConfigStore = createLlmConfigStorePort(storage);
  registerSettingsHandlers({
    ipcMain,
    safeStorage,
    llmConfigStore,
    uiPrefsStore: createUiPrefsStorePort(storage),
    workspaceFolderStore: createWorkspaceFolderStorePort(storage),
    providerCatalog,
    providerModels: { listModels: async () => ({ models: [] }) },
    REQ,
    getActiveWorkspaceRoot: () => null,
    presentation: createSettingsPresentationService({ providerCatalog, defaultProviderId: 'gateway' }),
    onShowHiddenFilesChanged,
  });
  const commit = (payload) => ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, {
    providerPatches: {},
    uiPrefs: {},
    ...payload,
  });
  return { commit, llmConfigStore, storage };
}

test('re-saving an entry with only a new address does not carry its secrets there (#560)', async (t) => {
  const { commit, llmConfigStore, storage } = await setup(t);
  const row = { id: 'p1', providerId: COMPAT.id, model: 'm1' };
  assert.equal((await commit({
    presets: [{ ...row, connection: { baseUrl: GOOD, apiKey: 'SECRET-KEY', extraHeaders: 'X-GW: SECRET-HDR' } }],
    activePresetId: 'p1',
  })).ok, true);

  assert.equal((await commit({ presets: [{ ...row, connection: { baseUrl: EVIL } }], activePresetId: 'p1' })).ok, true);

  const [stored] = (await llmConfigStore.readLLMConfig()).presets;
  assert.equal(stored.connection.baseUrl, EVIL);
  assert.equal(stored.connection.apiKeyEnc, undefined);
  assert.equal(stored.connection.extraHeadersEnc, undefined);
  const effective = await storage.getEffectiveProviderConfig(COMPAT.id, { presetId: 'p1' });
  assert.equal(effective.apiKey, undefined);
  assert.equal(effective.extraHeaders, undefined);
});

test('an entry id with surrounding spaces keeps its connection (#562)', async (t) => {
  const { commit, llmConfigStore } = await setup(t);

  await commit({
    presets: [{ id: '  p1  ', providerId: COMPAT.id, model: 'm1', connection: { baseUrl: GOOD, apiKey: 'k' } }],
    activePresetId: 'p1',
  });

  const [stored] = (await llmConfigStore.readLLMConfig()).presets;
  assert.equal(stored.id, 'p1');
  assert.equal(stored.connection.baseUrl, GOOD);
  assert.equal(stored.connection.apiKeyEnc, enc('k'));
});

test('a provider patch is held to the contract\'s limits (#562)', async (t) => {
  const { commit, llmConfigStore } = await setup(t);

  const result = await commit({
    presets: [{ id: 'g', providerId: GATEWAY.id, model: 'g1' }],
    activePresetId: 'g',
    providerPatches: { gateway: { apiKey: 'k', displayName: 'n'.repeat(100), extraHeaders: `X: ${'h'.repeat(5000)}` } },
  });

  assert.equal(result.ok, true);
  const entry = (await llmConfigStore.readLLMConfig()).providers.gateway;
  assert.equal(entry.displayName.length, 60);
  assert.equal(safeStorage.decryptString(Buffer.from(entry.extraHeadersEnc, 'base64')).length, 4000);
});

test('a patch for an unknown provider still refuses the model part (#562)', async (t) => {
  const { commit, llmConfigStore } = await setup(t);

  const result = await commit({
    presets: [{ id: 'g', providerId: GATEWAY.id, model: 'g1' }],
    providerPatches: { gateway: { apiKey: 'k' }, toString: { apiKey: 'x' } },
  });

  assert.equal(result.ok, false);
  assert.equal((await llmConfigStore.readLLMConfig()).presets.some((p) => p.id === 'g'), false);
});

test('the dialog\'s save announces a changed hidden-files switch like the toolbar does (#562)', async (t) => {
  const announced = [];
  const { commit } = await setup(t, { onShowHiddenFilesChanged: (value) => announced.push(value) });

  await commit({
    presets: [{ id: 'g', providerId: GATEWAY.id, model: 'g1' }],
    providerPatches: { gateway: { apiKey: 'k' } },
    uiPrefs: { showHiddenFiles: true },
  });

  assert.deepEqual(announced, [true]);
});

test('members of Object.prototype are no providers (#562)', () => {
  for (const id of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(getProvider(id), null, id);
  }
  assert.equal(getProvider('openai')?.id, 'openai');
});
