const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createProviderLlmAdapter } = require('../src/main/adapters/provider-llm-adapter');

const OPENAI_PRESET_FIELDS = [
  {
    key: 'reasoningEffort',
    type: 'select',
    options: [
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
    ],
  },
];

function makeProviders(overrides = {}) {
  const base = {
    test: {
      id: 'test',
      name: 'Test Provider',
      defaultModel: 'test-model',
      fields: {},
      async streamChatRound() {
        return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
    },
    openai: {
      id: 'openai',
      name: 'OpenAI',
      defaultModel: 'gpt-4o',
      fields: { apiKey: true },
      presentation: { presetFields: OPENAI_PRESET_FIELDS },
      async streamChatRound() {
        return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
    },
    ollama: {
      id: 'ollama',
      name: 'Ollama',
      defaultModel: 'llama3',
      defaultBaseUrl: 'http://127.0.0.1:11434',
      fields: { baseUrl: true },
      async streamChatRound() {
        return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
    },
  };
  return {
    getProvider(id) {
      return overrides[id] || base[id] || null;
    },
  };
}

function makeLlmConfigStore(overrides = {}) {
  return {
    readLLMConfig: async () => ({}),
    resolveChatModelTarget: () => ({
      providerId: 'test',
      model: 'test-model',
      reasoningEffort: null,
    }),
    ...overrides,
  };
}

function makeProviderSecrets(overrides = {}) {
  let configCall = 0;
  const secrets = {
    getEffectiveProviderConfig: async () => {
      configCall += 1;
      return { apiKey: 'sk-test', model: 'stored-model', baseUrl: 'http://stored' };
    },
    get configCalls() {
      return configCall;
    },
    ...overrides,
  };
  return secrets;
}

function makeAdapterDeps(overrides = {}) {
  const llmOverrides = overrides.llmConfigStore || {};
  const secretsOverrides = overrides.providerSecrets || {};
  return {
    providerRuntime: overrides.providerRuntime || makeProviders(),
    llmConfigStore: makeLlmConfigStore(llmOverrides),
    providerSecrets: makeProviderSecrets(secretsOverrides),
  };
}

test('adapter resolves unknown provider as INVALID chat error', async () => {
  const llm = createProviderLlmAdapter(makeAdapterDeps({
    llmConfigStore: {
      resolveChatModelTarget: () => ({ providerId: 'ghost', model: 'x' }),
    },
  }));

  const result = await llm.resolveChatTarget();
  assert.equal(result.code, 'INVALID');
  assert.match(result.error, /ghost/);
});

test('adapter merges only declared preset option keys into provider config', async () => {
  let capturedConfig = null;
  const providers = makeProviders();
  providers.getProvider = (id) => {
    if (id !== 'openai') return null;
    return {
      id: 'openai',
      name: 'OpenAI',
      defaultModel: 'gpt-4o',
      fields: { apiKey: true },
      presentation: { presetFields: OPENAI_PRESET_FIELDS },
      async streamChatRound({ config }) {
        capturedConfig = config;
        return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
    };
  };

  const llm = createProviderLlmAdapter(makeAdapterDeps({
    providerRuntime: providers,
    llmConfigStore: {
      resolveChatModelTarget: () => ({
        providerId: 'openai',
        model: 'gpt-4o',
        providerOptions: {
          reasoningEffort: 'high',
          secretBackdoor: 'nope',
        },
        reasoningEffort: 'high',
      }),
    },
    providerSecrets: {
      getEffectiveProviderConfig: async () => ({ apiKey: 'sk-test', model: 'gpt-4o' }),
    },
  }));

  const target = await llm.resolveChatTarget();
  assert.deepEqual(target.providerOptions, { reasoningEffort: 'high' });

  const bundle = await llm.prepareSendBundle(target);
  await llm.streamRound({
    target,
    sendBundle: bundle,
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: {},
    abortSignal: new AbortController().signal,
  });

  assert.equal(capturedConfig.reasoningEffort, 'high');
  assert.equal(capturedConfig.secretBackdoor, undefined);
});

test('adapter prepareSendBundle snapshots config and model for multi-round reuse', async () => {
  let configCalls = 0;
  const providerSecrets = makeProviderSecrets({
    getEffectiveProviderConfig: async () => {
      configCalls += 1;
      return {
        apiKey: 'sk-test',
        model: configCalls === 1 ? 'stored-model' : 'mutated-model',
      };
    },
  });

  const captured = [];
  let round = 0;
  const providers = makeProviders();
  providers.getProvider = () => ({
    id: 'openai',
    name: 'OpenAI',
    defaultModel: 'gpt-4o',
    fields: { apiKey: true },
    presentation: { presetFields: OPENAI_PRESET_FIELDS },
    async streamChatRound({ config, model }) {
      captured.push({ config, model });
      round += 1;
      if (round === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
          },
          finishReason: 'tool_calls',
        };
      }
      return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
  });

  const llm = createProviderLlmAdapter(makeAdapterDeps({
    providerRuntime: providers,
    llmConfigStore: {
      resolveChatModelTarget: () => ({
        providerId: 'openai',
        model: 'preset-model',
        providerOptions: { reasoningEffort: 'medium' },
      }),
    },
    providerSecrets,
  }));
  const target = await llm.resolveChatTarget();
  const bundle = await llm.prepareSendBundle(target);

  await llm.streamRound({
    target,
    sendBundle: bundle,
    messages: [{ role: 'user', content: 'a' }],
    callbacks: {},
    abortSignal: new AbortController().signal,
  });
  await llm.streamRound({
    target,
    sendBundle: bundle,
    messages: [{ role: 'user', content: 'a' }, { role: 'tool', tool_call_id: 'c1', content: '{}' }],
    callbacks: {},
    abortSignal: new AbortController().signal,
  });

  assert.equal(configCalls, 1);
  assert.equal(captured.length, 2);
  assert.deepEqual(captured[0].config, captured[1].config);
  assert.equal(captured[0].model, 'preset-model');
  assert.equal(captured[1].model, 'preset-model');
  assert.equal(captured[0].config.reasoningEffort, 'medium');
});

test('adapter falls back to stored model and base URL when target omits them', async () => {
  let captured = null;
  const providers = makeProviders();
  providers.getProvider = (id) => {
    const p = makeProviders().getProvider(id);
    if (!p) return null;
    return {
      ...p,
      async streamChatRound(args) {
        captured = args;
        return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
    };
  };
  const llm = createProviderLlmAdapter(makeAdapterDeps({
    providerRuntime: providers,
    llmConfigStore: {
      resolveChatModelTarget: () => ({ providerId: 'ollama', model: '' }),
    },
    providerSecrets: {
      getEffectiveProviderConfig: async () => ({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'stored-ollama-model',
      }),
    },
  }));

  const target = await llm.resolveChatTarget();
  const bundle = await llm.prepareSendBundle(target);
  await llm.streamRound({
    target,
    sendBundle: bundle,
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: {},
    abortSignal: new AbortController().signal,
  });

  assert.equal(captured.model, 'stored-ollama-model');
  assert.equal(captured.config.baseUrl, 'http://127.0.0.1:11434');
});

test('adapter resolves legacy reasoningEffort wire field via declared preset keys', async () => {
  const llm = createProviderLlmAdapter(makeAdapterDeps({
    llmConfigStore: {
      resolveChatModelTarget: () => ({
        providerId: 'openai',
        model: 'gpt-4o',
        reasoningEffort: 'low',
      }),
    },
  }));

  const target = await llm.resolveChatTarget();
  assert.deepEqual(target.providerOptions, { reasoningEffort: 'low' });
});

test('adapter validateTarget returns NO_API_KEY with send-specific suffix', async () => {
  const llm = createProviderLlmAdapter(makeAdapterDeps({
    providerSecrets: {
      getEffectiveProviderConfig: async () => ({}),
    },
    llmConfigStore: {
      resolveChatModelTarget: () => ({ providerId: 'openai', model: 'gpt-4o' }),
    },
  }));

  const target = await llm.resolveChatTarget();
  const sendErr = await llm.validateTarget(target, { forSend: true });
  const explainErr = await llm.validateTarget(target, { forSend: false });

  assert.equal(sendErr.code, 'NO_API_KEY');
  assert.match(sendErr.error, /Einstellungen speichern/);
  assert.equal(explainErr.code, 'NO_API_KEY');
  assert.doesNotMatch(explainErr.error, /Einstellungen speichern/);
});

// --- Provider „OpenAI-kompatibel" (Issue #193) ----------------------------

const COMPAT_PROVIDER = {
  id: 'openai-compatible',
  name: 'OpenAI-kompatibel',
  defaultModel: '',
  defaultBaseUrl: 'http://localhost:1234/v1',
  optionalApiKey: true,
  fields: { apiKey: true, baseUrl: true },
  capabilitiesFor(config) {
    return { images: config?.supportsImages === true };
  },
  async streamChatRound() {
    return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
  },
};

function compatAdapter(storedConfig) {
  return createProviderLlmAdapter(
    makeAdapterDeps({
      providerRuntime: { getProvider: (id) => (id === 'openai-compatible' ? COMPAT_PROVIDER : null) },
      providerSecrets: { getEffectiveProviderConfig: async () => storedConfig },
    })
  );
}

test('ein optionaler API-Key blockiert den Versand nicht (#193)', async () => {
  const llm = compatAdapter({ baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5' });
  const error = await llm.validateTarget(
    { providerId: 'openai-compatible', model: 'qwen2.5' },
    { forSend: true }
  );
  assert.equal(error, null);
});

test('eine fehlende Server-URL bleibt ein Fehler', async () => {
  const llm = compatAdapter({ model: 'qwen2.5' });
  const error = await llm.validateTarget({ providerId: 'openai-compatible', model: 'qwen2.5' });
  assert.equal(error.code, 'NO_BASE_URL');
});

test('prepareSendBundle nimmt Anzeigenamen und Bild-Faehigkeit aus der Konfiguration', async () => {
  const withImages = await compatAdapter({
    baseUrl: 'http://localhost:1234/v1',
    displayName: '  LM Studio  ',
    supportsImages: true,
  }).prepareSendBundle({ providerId: 'openai-compatible', model: 'qwen2.5' });
  assert.equal(withImages.providerName, 'LM Studio');
  assert.deepEqual(withImages.capabilities, { images: true });

  const plain = await compatAdapter({ baseUrl: 'http://localhost:1234/v1' })
    .prepareSendBundle({ providerId: 'openai-compatible', model: 'qwen2.5' });
  assert.equal(plain.providerName, 'OpenAI-kompatibel');
  assert.deepEqual(plain.capabilities, { images: false });
});
