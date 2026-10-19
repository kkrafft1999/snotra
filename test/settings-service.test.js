const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createLlmPresets,
  describeKeyReadability,
  isProviderConfigured,
} = require('../src/main/services/llm-settings');
const { createSettingsService } = require('../src/main/services/settings-service');

// The settings rules without IPC (#1006): the service is driven directly,
// against stores held in memory.

const PROVIDERS = {
  openai: { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o', fields: { apiKey: true } },
  ollama: { id: 'ollama', name: 'Ollama', defaultModel: 'llama3', defaultBaseUrl: 'http://127.0.0.1:11434', fields: { baseUrl: true } },
};
const providerCatalog = { getProvider: (/** @type {string} */ id) => PROVIDERS[id] || null };

const secretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (/** @type {string} */ plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (/** @type {Buffer} */ buf) => {
    const s = buf.toString('utf8');
    if (!s.startsWith('enc:')) throw new Error('bad cipher');
    return s.slice(4);
  },
};
const enc = (/** @type {string} */ plain) => Buffer.from(`enc:${plain}`, 'utf8').toString('base64');

function memoryLlmConfigStore(initial) {
  let config = structuredClone(initial);
  return {
    readLLMConfig: async () => structuredClone(config),
    updateLLMConfig: async (update) => {
      config = structuredClone(await update(structuredClone(config)));
      return structuredClone(config);
    },
    resolveChatModelTarget: (doc) => {
      const preset = (doc.presets || []).find((p) => p.id === doc.activePresetId) || doc.presets?.[0];
      return { providerId: preset?.providerId, model: preset?.model, presetId: preset?.id };
    },
    normalizePresetEntry: (row) => (row && typeof row.id === 'string' && row.providerId
      ? { id: row.id.trim(), providerId: row.providerId, model: row.model || '' }
      : null),
  };
}

function memoryUiPrefsStore({ failWrites = false } = {}) {
  let prefs = { appLocale: 'en' };
  return {
    readUIPrefs: async () => ({ ...prefs }),
    updateUIPrefs: async (update) => {
      if (failWrites) throw new Error('disk full');
      const out = { ...prefs };
      await update(out);
      prefs = out;
      return { ...prefs };
    },
  };
}

const TWO_ENTRIES = {
  presets: [
    { id: 'p1', providerId: 'openai', model: 'gpt-4o' },
    { id: 'p2', providerId: 'ollama', model: 'llama3' },
  ],
  activePresetId: 'p1',
  defaultPresetId: 'p1',
  providers: { openai: { apiKeyEnc: enc('sk-1') }, ollama: {} },
};

function setup({ config = TWO_ENTRIES, uiPrefs = memoryUiPrefsStore() } = {}) {
  const llmConfigStore = memoryLlmConfigStore(config);
  const presets = createLlmPresets({ llmConfigStore, providerCatalog, secretStore });
  /** @type {string[]} */
  const remembered = [];
  const service = createSettingsService({
    secretStore,
    llmConfigStore,
    uiPrefsStore: uiPrefs,
    providerCatalog,
    presets,
    chatSessionSettings: {
      reasoningEffortFor: async () => null,
      rememberReasoningEffort: async () => true,
      rememberPreset: async (id) => { remembered.push(id); },
    },
  });
  return { service, presets, llmConfigStore, remembered };
}

test('an entry is usable with a readable key or, for a local server, a URL', () => {
  assert.equal(isProviderConfigured({ secretStore }, PROVIDERS.openai, { apiKeyEnc: enc('k') }), true);
  assert.equal(isProviderConfigured({ secretStore }, PROVIDERS.openai, { apiKeyEnc: 'not-ours' }), false);
  assert.equal(isProviderConfigured({ secretStore }, PROVIDERS.openai, {}), false);
  assert.equal(isProviderConfigured({ secretStore }, PROVIDERS.ollama, {}), true, 'the default URL counts');
});

test('key readability is reported per provider and, separately, per entry', () => {
  const readable = describeKeyReadability(secretStore, {
    providers: { openai: { apiKeyEnc: enc('k') }, other: { apiKeyEnc: 'garbage' } },
    presets: [{ id: 'openai', providerId: 'x', connection: { apiKeyEnc: 'garbage' } }],
  });
  assert.deepEqual(readable, { openai: true, other: false, 'preset:openai': false });
});

test('setting the active entry from the chat bar makes it the default and the chat remembers it', async () => {
  const { service, llmConfigStore, remembered } = setup();
  assert.equal((await service.setActivePreset(' p2 ')).ok, true);
  const config = await llmConfigStore.readLLMConfig();
  assert.equal(config.activePresetId, 'p2');
  assert.equal(config.defaultPresetId, 'p2');
  assert.deepEqual(remembered, ['p2']);
});

test('restoring a chat sets the entry but leaves the default; an unusable entry is refused', async () => {
  const { presets, llmConfigStore } = setup({
    config: { ...TWO_ENTRIES, providers: { openai: {}, ollama: {} }, activePresetId: 'p2', defaultPresetId: 'p2' },
  });
  assert.equal((await presets.applyActivePreset('p1')).ok, false, 'p1 has no key');
  assert.equal(await presets.isPresetUsable('p1'), false);
  assert.equal(await presets.isPresetUsable('p2'), true);
  assert.equal(await presets.isPresetUsable('gone'), false);
  assert.equal((await llmConfigStore.readLLMConfig()).activePresetId, 'p2');
});

test('a save without entries refuses the model part and still writes the preferences', async () => {
  const { service } = setup();
  const result = await service.commitSettings({ presets: [], uiPrefs: { baseSystemPrompt: 'Be brief.' } });
  assert.equal(result.ok, false);
  assert.equal(result.uiPrefsSaved, true);
});

test('a key is encrypted on save, and providers no entry uses are dropped', async () => {
  const { service, llmConfigStore, remembered } = setup({
    config: { ...TWO_ENTRIES, providers: { openai: {}, ollama: {} } },
  });
  const result = await service.commitSettings({
    presets: [{ id: 'p1', providerId: 'openai', model: 'gpt-4o' }],
    activePresetId: 'p1',
    providerPatches: { openai: { apiKey: 'sk-new' } },
  });
  assert.equal(result.ok, true);
  const config = await llmConfigStore.readLLMConfig();
  assert.equal(config.providers.openai.apiKeyEnc, enc('sk-new'));
  assert.equal(config.providers.ollama, undefined);
  assert.deepEqual(remembered, ['p1']);
});

test('when the preferences cannot be written the model part is rolled back', async () => {
  const { service, llmConfigStore } = setup({ uiPrefs: memoryUiPrefsStore({ failWrites: true }) });
  const before = await llmConfigStore.readLLMConfig();
  const result = await service.commitSettings({
    presets: [{ id: 'p2', providerId: 'ollama', model: 'llama3' }],
    activePresetId: 'p2',
    uiPrefs: { baseSystemPrompt: 'Be brief.' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.key, 'settings.error.uiNotSaved.rolledBack');
  assert.deepEqual(await llmConfigStore.readLLMConfig(), before);
});

test('the reasoning level is refused for a model without levels', async () => {
  const { service } = setup();
  const result = await service.setReasoningEffort('high');
  assert.equal(result.ok, false);
});
