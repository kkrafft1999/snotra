const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  registerSettingsHandlers,
  mergeProviderPatchIntoConfigImpl,
} = require('../src/main/ipc/settings-handlers');
const { createStorageService } = require('../src/main/services/storage-service');
const {
  createLlmConfigStorePort,
  createUiPrefsStorePort,
  createWorkspaceFolderStorePort,
} = require('../src/main/adapters/persistence-store-adapters');
const {
  createMockProviderRuntime,
  createMockProviderCatalog,
} = require('./helpers/provider-ports');
const { createProviderModelListingAdapter } = require('../src/main/adapters/provider-model-listing-adapter');
const { createProviderSecretsPort } = require('../src/main/adapters/provider-secrets-adapter');
const { createSettingsPresentationService } = require('../src/main/services/settings-presentation-service');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

const mockProviders = {
  getProvider(id) {
    if (id === 'openai') {
      return { defaultModel: 'gpt-4o', fields: { apiKey: true } };
    }
    if (id === 'ollama') {
      return { defaultModel: 'llama3', fields: { baseUrl: true } };
    }
    return null;
  },
};

function makeDeps(encryptionAvailable = true) {
  const runtime = createMockProviderRuntime((id) => mockProviders.getProvider(id));
  return {
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString(plaintext) {
        return Buffer.from(`enc:${plaintext}`, 'utf8');
      },
    },
    providerCatalog: createMockProviderCatalog((id) => mockProviders.getProvider(id)),
  };
}

test('mergeProviderPatchIntoConfigImpl removes apiKeyEnc when removeApiKey is true', () => {
  const config = {
    providers: {
      openai: {
        apiKeyEnc: 'stored-key',
        model: 'gpt-4o',
      },
    },
  };

  const res = mergeProviderPatchIntoConfigImpl(makeDeps(), config, 'openai', {
    removeApiKey: true,
  });

  assert.equal(res.ok, true);
  assert.equal(config.providers.openai.apiKeyEnc, undefined);
  assert.equal(config.providers.openai.model, 'gpt-4o');
});

test('mergeProviderPatchIntoConfigImpl replaces key after removal when new apiKey is set', () => {
  const config = {
    providers: {
      openai: {
        apiKeyEnc: 'stored-key',
      },
    },
  };

  const res = mergeProviderPatchIntoConfigImpl(makeDeps(), config, 'openai', {
    removeApiKey: true,
    apiKey: 'new-secret',
  });

  assert.equal(res.ok, true);
  assert.equal(config.providers.openai.apiKeyEnc, Buffer.from('enc:new-secret', 'utf8').toString('base64'));
});

test('mergeProviderPatchIntoConfigImpl does not require encryption for removal only', () => {
  const config = {
    providers: {
      openai: {
        apiKeyEnc: 'stored-key',
      },
    },
  };

  const res = mergeProviderPatchIntoConfigImpl(makeDeps(false), config, 'openai', {
    removeApiKey: true,
  });

  assert.equal(res.ok, true);
  assert.equal(config.providers.openai.apiKeyEnc, undefined);
});

// --- registerSettingsHandlers: commitSettings flow + listModels error paths ---

function makeHandlerProviders({ listModelsImpl } = {}) {
  const metaById = {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      fields: { apiKey: true },
      defaultModel: 'gpt-4o',
      presentation: {
        apiKeyPlaceholder: 'sk-…',
        presetFields: [{
          key: 'reasoningEffort',
          type: 'select',
          defaultValue: 'medium',
          affectsPresetIdentity: true,
          detailStyle: 'mono',
          detailPrefix: 'reasoning_effort: ',
          options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
          formatDetail: (v) => `reasoning_effort: ${v}`,
        }],
      },
      listModels: listModelsImpl || (async () => ({ models: [] })),
    },
    ollama: {
      id: 'ollama',
      name: 'Ollama',
      fields: { baseUrl: true },
      defaultModel: 'llama3',
      defaultBaseUrl: 'http://127.0.0.1:11434',
      presentation: {
        baseUrlPlaceholder: 'http://localhost:11434',
        connectionDetail: true,
      },
      listModels: listModelsImpl || (async () => ({ models: [] })),
    },
  };
  return {
    getProvider: (id) => metaById[id] || null,
    listProviderMeta: () => Object.values(metaById),
  };
}

async function setupHandlers(t, { encryptionAvailable = true, listModelsImpl, toolCatalog, skillCatalog } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-settings-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad cipher');
      return s.slice(4);
    },
  };
  const providers = makeHandlerProviders({ listModelsImpl });
  const providerRuntime = createMockProviderRuntime(
    (id) => providers.getProvider(id),
    { listMeta: () => providers.listProviderMeta() }
  );
  const providerCatalog = createMockProviderCatalog(
    (id) => providers.getProvider(id),
    { listMeta: () => providers.listProviderMeta() }
  );
  const storage = createStorageService({
    app: { getPath: () => tmpDir },
    safeStorage,
    fs,
    path,
    providerCatalog,
    maxChatSessions: 10,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  const llmConfigStore = createLlmConfigStorePort(storage);
  const providerSecrets = createProviderSecretsPort(storage);
  const uiPrefsStore = createUiPrefsStorePort(storage);
  const workspaceFolderStore = createWorkspaceFolderStorePort(storage);
  const providerModels = createProviderModelListingAdapter({ providerRuntime, providerSecrets });
  const presentation = createSettingsPresentationService({
    providerCatalog,
    defaultProviderId: 'openai',
  });
  const ipcMain = createMockIpcMain();
  registerSettingsHandlers({
    ipcMain,
    safeStorage,
    llmConfigStore,
    uiPrefsStore,
    workspaceFolderStore,
    providerCatalog,
    providerModels,
    REQ,
    setActiveWorkspaceRoot: () => {},
    presentation,
    toolCatalog,
    skillCatalog,
  });
  return { ipcMain, storage, llmConfigStore, uiPrefsStore };
}

test('getToolCatalog returns the registry catalog, or an empty list without one', async (t) => {
  const catalog = [
    { name: 'list_directory', description: 'Listet Einträge.', requiresWrite: false },
    { name: 'write_file_text', description: 'Schreibt Dateien.', requiresWrite: true },
  ];
  const { ipcMain } = await setupHandlers(t, {
    toolCatalog: { listCatalog: () => catalog },
  });
  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_GET_TOOL_CATALOG), { tools: catalog });

  const { ipcMain: withoutCatalog } = await setupHandlers(t);
  assert.deepEqual(await withoutCatalog.invoke(REQ.SETTINGS_GET_TOOL_CATALOG), { tools: [] });
});

test('registerSettingsHandlers requires injected presentation service', () => {
  const ipcMain = createMockIpcMain();
  assert.throws(
    () => registerSettingsHandlers({
      ipcMain,
      safeStorage: { isEncryptionAvailable: () => false },
      llmConfigStore: {},
      uiPrefsStore: {},
      workspaceFolderStore: {},
      providerCatalog: { getProvider: () => null, listProviderMeta: () => [] },
      providerModels: { listModels: async () => ({ models: [] }) },
      REQ,
      setActiveWorkspaceRoot: () => {},
    }),
    /requires an injected settings presentation service/
  );
});

test('commitSettings rejects an empty preset list', async (t) => {
  const { ipcMain } = await setupHandlers(t);
  const res = await ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, { presets: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /Mindestens ein Modell-Eintrag/);
});

test('commitSettings rejects duplicate preset ids', async (t) => {
  const { ipcMain } = await setupHandlers(t);
  const res = await ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, {
    presets: [
      { id: 'p1', providerId: 'ollama', model: 'llama3' },
      { id: 'p1', providerId: 'ollama', model: 'mistral' },
    ],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Doppelte Eintrags-IDs/);
});

test('commitSettings fails early when a key arrives without encrypted storage', async (t) => {
  const { ipcMain } = await setupHandlers(t, { encryptionAvailable: false });
  const res = await ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, {
    presets: [{ id: 'p1', providerId: 'openai', model: 'gpt-4o' }],
    providerPatches: { openai: { apiKey: 'sk-test' } },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Verschlüsselter Speicher/);
});

test('commitSettings rejects presets whose provider is not configured', async (t) => {
  const { ipcMain, storage } = await setupHandlers(t);
  const res = await ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, {
    presets: [{ id: 'p1', providerId: 'openai', model: 'gpt-4o' }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unvollständig/);
  const config = await storage.readLLMConfig();
  assert.equal(
    config.presets.some((p) => p.id === 'p1'),
    false,
    'failed commit must not persist presets'
  );
});

test('commitSettings does not persist provider patches when preset validation fails', async (t) => {
  const { ipcMain, storage } = await setupHandlers(t);
  await storage.updateLLMConfig(async (config) => {
    config.providers = {
      openai: { apiKeyEnc: 'stored-key' },
      ollama: { baseUrl: 'http://old:1' },
    };
    return config;
  });

  const res = await ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, {
    presets: [{ id: 'p1', providerId: 'openai', model: 'gpt-4o' }],
    providerPatches: { openai: { removeApiKey: true } },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unvollständig/);

  const config = await storage.readLLMConfig();
  assert.equal(config.providers.openai?.apiKeyEnc, 'stored-key', 'provider patch must not persist');
  assert.equal(config.providers.ollama?.baseUrl, 'http://old:1', 'existing provider entries must stay unchanged');
  assert.equal(config.presets.some((p) => p.id === 'p1'), false);
});

test('commitSettings persists presets, encrypts keys, prunes unused providers and writes UI prefs', async (t) => {
  const { ipcMain, storage } = await setupHandlers(t);
  await storage.updateLLMConfig(async (config) => {
    config.providers = { ollama: { baseUrl: 'http://old:1' } };
    return config;
  });

  const res = await ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, {
    presets: [
      { id: 'p1', providerId: 'openai', model: 'gpt-4o-mini' },
      { id: 'p2', providerId: 'openai', model: 'gpt-4o' },
    ],
    activePresetId: 'p2',
    providerPatches: { openai: { apiKey: ' sk-secret ' } },
    uiPrefs: { maxToolRounds: 9999, appLocale: 'en' },
  });
  assert.deepEqual(res, { ok: true });

  const config = await storage.readLLMConfig();
  assert.equal(config.version, 3);
  assert.deepEqual(config.presets.map((p) => p.id), ['p1', 'p2']);
  assert.equal(config.activePresetId, 'p2');
  assert.equal(config.activeProvider, 'openai');
  assert.equal(config.providers.openai.model, 'gpt-4o');
  assert.equal(
    config.providers.openai.apiKeyEnc,
    Buffer.from('enc:sk-secret', 'utf8').toString('base64'),
    'key must be trimmed and encrypted'
  );
  assert.equal(config.providers.ollama, undefined, 'unused provider entries must be pruned');

  const prefs = await storage.readUIPrefs();
  assert.equal(prefs.maxToolRounds, 500, 'maxToolRounds must be clamped');
  assert.equal(prefs.appLocale, 'en');
});

test('commitSettings falls back to the first preset when activePresetId is unknown', async (t) => {
  const { ipcMain, storage } = await setupHandlers(t);
  const res = await ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, {
    presets: [{ id: 'p1', providerId: 'ollama', model: 'llama3' }],
    activePresetId: 'does-not-exist',
  });
  assert.deepEqual(res, { ok: true });
  const config = await storage.readLLMConfig();
  assert.equal(config.activePresetId, 'p1');
  assert.equal(config.activeProvider, 'ollama');
});

test('listModels returns an error for unknown providers', async (t) => {
  const { ipcMain } = await setupHandlers(t);
  const res = await ipcMain.invoke(REQ.SETTINGS_LIST_MODELS, { providerId: 'nope' });
  assert.deepEqual(res, { error: 'Unbekannter Provider.' });
});

test('listModels surfaces provider exceptions as error results', async (t) => {
  const { ipcMain } = await setupHandlers(t, {
    listModelsImpl: async () => {
      throw new Error('Server nicht erreichbar');
    },
  });
  const res = await ipcMain.invoke(REQ.SETTINGS_LIST_MODELS, { providerId: 'ollama' });
  assert.deepEqual(res, { error: 'Server nicht erreichbar' });
});

test('listModels prefers incoming credentials over stored config', async (t) => {
  let seenConfig = null;
  const { ipcMain, storage } = await setupHandlers(t, {
    listModelsImpl: async (config) => {
      seenConfig = config;
      return { models: [{ id: 'm1', label: 'm1' }] };
    },
  });
  await storage.updateLLMConfig(async (config) => {
    config.providers = {
      openai: { apiKeyEnc: Buffer.from('enc:stored-key', 'utf8').toString('base64') },
    };
    return config;
  });

  const res = await ipcMain.invoke(REQ.SETTINGS_LIST_MODELS, {
    providerId: 'openai',
    apiKey: ' incoming-key ',
  });
  assert.deepEqual(res, { models: [{ id: 'm1', label: 'm1' }] });
  assert.equal(seenConfig.apiKey, 'incoming-key');

  await ipcMain.invoke(REQ.SETTINGS_LIST_MODELS, { providerId: 'openai' });
  assert.equal(seenConfig.apiKey, 'stored-key', 'stored key must be decrypted as fallback');
});

test('setUIPrefs persists a clamped historyCharLimit', async (t) => {
  const { ipcMain, storage } = await setupHandlers(t);
  await ipcMain.invoke(REQ.SETTINGS_SET_UI_PREFS, { historyCharLimit: 100 });
  let prefs = await storage.readUIPrefs();
  assert.equal(prefs.historyCharLimit, 4000, 'limit must be clamped to the minimum');

  await ipcMain.invoke(REQ.SETTINGS_SET_UI_PREFS, { historyCharLimit: 50_000 });
  prefs = await storage.readUIPrefs();
  assert.equal(prefs.historyCharLimit, 50_000);

  await ipcMain.invoke(REQ.SETTINGS_SET_UI_PREFS, { historyCharLimit: 'nope' });
  prefs = await storage.readUIPrefs();
  assert.equal(prefs.historyCharLimit, 50_000, 'invalid values must not overwrite the stored limit');
});

test('getLLMState returns normalized preset and provider view DTOs', async (t) => {
  const { ipcMain, storage } = await setupHandlers(t);
  await storage.updateLLMConfig(async (config) => {
    config.providers = {
      openai: {
        apiKeyEnc: Buffer.from('enc:key', 'utf8').toString('base64'),
        model: 'gpt-4o',
      },
    };
    config.presets = [
      { id: 'p1', providerId: 'openai', model: 'gpt-4o', reasoningEffort: 'low', menuVisible: true },
    ];
    config.activePresetId = 'p1';
    return config;
  });

  const state = await ipcMain.invoke(REQ.SETTINGS_GET_LLM_STATE);
  assert.equal(state.encryptionAvailable, true);
  assert.equal(state.presets.length, 1);
  assert.equal(state.presets[0].label, 'OpenAI · gpt-4o');
  assert.equal(state.presets[0].sublabel, 'reasoning_effort: low');
  assert.equal(state.providers.find((p) => p.id === 'openai').form.showApiKey, true);
  assert.equal(state.providers.find((p) => p.id === 'openai').configured, true);
  assert.equal(state.providers.find((p) => p.id === 'openai').fields, undefined);
});

// --- Gespeicherter, aber nicht entschluesselbarer Key (#54) ---

async function seedUnreadableOpenAiKey(storage) {
  await storage.updateLLMConfig(async (config) => {
    config.providers = {
      openai: {
        // Ciphertext eines fremden Schluessels: decryptString wirft.
        apiKeyEnc: Buffer.from('garbage-from-other-key', 'utf8').toString('base64'),
        model: 'gpt-4o',
      },
    };
    config.presets = [{ id: 'p1', providerId: 'openai', model: 'gpt-4o', menuVisible: true }];
    config.activePresetId = 'p1';
    config.activeProvider = 'openai';
    return config;
  });
}

test('getLLMState reports a stored but undecryptable key as not configured', async (t) => {
  const { ipcMain, storage } = await setupHandlers(t);
  await seedUnreadableOpenAiKey(storage);

  const state = await ipcMain.invoke(REQ.SETTINGS_GET_LLM_STATE);
  const openai = state.providers.find((p) => p.id === 'openai');
  assert.equal(openai.hasKey, true);
  assert.equal(openai.keyUnreadable, true);
  assert.equal(openai.configured, false);
  assert.equal(state.presets.find((p) => p.id === 'p1').configured, false);
});

test('setActivePreset refuses a provider whose stored key cannot be decrypted', async (t) => {
  const { ipcMain, storage } = await setupHandlers(t);
  await seedUnreadableOpenAiKey(storage);

  const res = await ipcMain.invoke(REQ.SETTINGS_SET_ACTIVE_PRESET, 'p1');
  assert.equal(res.ok, false);
  assert.match(res.error, /noch nicht konfiguriert/);
});

test('commitSettings treats an undecryptable key as incomplete access', async (t) => {
  const { ipcMain, storage } = await setupHandlers(t);
  await seedUnreadableOpenAiKey(storage);

  const res = await ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, {
    presets: [{ id: 'p1', providerId: 'openai', model: 'gpt-4o', menuVisible: true }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unvollständig/);
});

test('removeFolderFromHistory drops one entry and returns the remaining list', async (t) => {
  const { ipcMain } = await setupHandlers(t);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-ws-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  await fs.mkdir(a);
  await fs.mkdir(b);
  await ipcMain.invoke(REQ.SETTINGS_SET_LAST_FOLDER, a);
  await ipcMain.invoke(REQ.SETTINGS_SET_LAST_FOLDER, b);
  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_GET_FOLDER_HISTORY), { paths: [b, a] });

  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_REMOVE_FOLDER_FROM_HISTORY, a), { ok: true, paths: [b] });
  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_GET_FOLDER_HISTORY), { paths: [b] });

  // Unbekannter Eintrag: ok=false, Liste unverändert.
  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_REMOVE_FOLDER_FROM_HISTORY, a), { ok: false, paths: [b] });

  // Der aktuell geöffnete Ordner darf aus dem Verlauf, bleibt aber last folder.
  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_REMOVE_FOLDER_FROM_HISTORY, b), { ok: true, paths: [] });
  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_GET_LAST_FOLDER), { folderPath: b });
});

test('getSkillCatalog reicht die gespeicherte Auswahl an den Skill-Service durch', async (t) => {
  const calls = [];
  const { ipcMain } = await setupHandlers(t, {
    skillCatalog: {
      listCatalog: async (options) => {
        calls.push(options);
        return { skills: [{ name: 'snotra-capabilities', source: 'system', status: 'active' }] };
      },
      reload: () => calls.push('reload'),
    },
  });

  const result = await ipcMain.invoke(REQ.SETTINGS_GET_SKILL_CATALOG, '/tmp/ws');
  assert.equal(result.skills[0].name, 'snotra-capabilities');
  assert.deepEqual(calls, [{ workspaceRoot: '/tmp/ws', activeSkills: null }]);

  await ipcMain.invoke(REQ.SETTINGS_SET_UI_PREFS, { activeSkills: ['snotra-capabilities'] });
  await ipcMain.invoke(REQ.SETTINGS_GET_SKILL_CATALOG, null);
  assert.deepEqual(calls[1], { workspaceRoot: null, activeSkills: ['snotra-capabilities'] });
});

test('reloadSkills verwirft den Cache und liefert den frischen Katalog', async (t) => {
  const calls = [];
  const { ipcMain } = await setupHandlers(t, {
    skillCatalog: {
      listCatalog: async () => ({ skills: [] }),
      reload: () => calls.push('reload'),
    },
  });

  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_RELOAD_SKILLS, null), { skills: [] });
  assert.deepEqual(calls, ['reload']);
});

test('ohne Skill-Service liefern beide Kanäle eine leere Liste', async (t) => {
  const { ipcMain } = await setupHandlers(t);
  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_GET_SKILL_CATALOG, null), { skills: [] });
  assert.deepEqual(await ipcMain.invoke(REQ.SETTINGS_RELOAD_SKILLS, null), { skills: [] });
});

test('activeSkills überleben den Weg durch setUIPrefs', async (t) => {
  const { ipcMain } = await setupHandlers(t);
  const saved = await ipcMain.invoke(REQ.SETTINGS_SET_UI_PREFS, { activeSkills: ['a', 'a', 'b'] });
  assert.deepEqual(saved.activeSkills, ['a', 'b']);
  const reread = await ipcMain.invoke(REQ.SETTINGS_GET_UI_PREFS);
  assert.deepEqual(reread.activeSkills, ['a', 'b']);
});
