const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createProviderLlmAdapter } = require('../src/main/adapters/provider-llm-adapter');

// The level is the chat's since #726; the summary stays an entry option.
const OPENAI_PRESET_FIELDS = [
  {
    key: 'reasoningSummary',
    type: 'select',
    options: [
      { value: 'off', label: 'off' },
      { value: 'auto', label: 'auto' },
    ],
  },
];

// The levels a chat can choose (#725); without `appliesTo` every model takes them.
const OPENAI_REASONING = { levels: ['low', 'medium', 'high'], defaultLevel: 'medium' };

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
    reasoning: OPENAI_REASONING,
      reasoning: OPENAI_REASONING,
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
    ...(overrides.reasoningLevelFor ? { reasoningLevelFor: overrides.reasoningLevelFor } : {}),
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
  assert.deepEqual(result.error, { key: 'provider.error.unknown', params: { id: 'ghost' } });
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
    reasoning: OPENAI_REASONING,
      reasoning: OPENAI_REASONING,
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
          reasoningSummary: 'auto',
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
  // The level is the chat's (#725), an entry's leftover one counts for nothing (#726).
  assert.equal(target.reasoningEffort, 'medium');
  assert.deepEqual(target.providerOptions, { reasoningSummary: 'auto' });

  const bundle = await llm.prepareSendBundle(target);
  await llm.streamRound({
    target,
    sendBundle: bundle,
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: {},
    abortSignal: new AbortController().signal,
  });

  assert.equal(capturedConfig.reasoningEffort, 'medium');
  assert.equal(capturedConfig.reasoningSummary, 'auto');
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
    reasoning: OPENAI_REASONING,
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

test('an entry\'s leftover level is no longer passed on (#726)', async () => {
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
  assert.equal(target.reasoningEffort, 'medium');
  assert.equal(target.providerOptions, undefined);
});

// The level belongs to the chat (#725).
function levelAdapter({ entryLevel, own, model = 'gpt-5', appliesTo, storedConfig = {} } = {}) {
  const asked = [];
  let sent = null;
  const providers = makeProviders({
    openai: {
      id: 'openai',
      name: 'OpenAI',
      defaultModel: 'gpt-5',
      fields: { apiKey: true },
      presentation: { presetFields: OPENAI_PRESET_FIELDS },
      reasoning: { ...OPENAI_REASONING, ...(appliesTo ? { appliesTo } : {}) },
      async streamChatRound({ config }) {
        sent = config;
        return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
    },
  });
  const llm = createProviderLlmAdapter(makeAdapterDeps({
    providerRuntime: providers,
    llmConfigStore: {
      resolveChatModelTarget: () => ({
        providerId: 'openai',
        model,
        ...(entryLevel ? { providerOptions: { reasoningEffort: entryLevel } } : {}),
      }),
    },
    providerSecrets: {
      getEffectiveProviderConfig: async () => ({ apiKey: 'sk-test', ...storedConfig }),
    },
    reasoningLevelFor: async (chatId) => {
      asked.push(chatId);
      if (own instanceof Error) throw own;
      return own;
    },
  }));
  return {
    llm,
    asked,
    async send(target) {
      await llm.streamRound({
        target,
        sendBundle: await llm.prepareSendBundle(target),
        messages: [{ role: 'user', content: 'Hi' }],
        callbacks: {},
        abortSignal: new AbortController().signal,
      });
      return sent;
    },
  };
}

test('the chat\'s own level wins over the entry\'s, for the chat the round is for (#725)', async () => {
  const { llm, asked, send } = levelAdapter({ entryLevel: 'low', own: 'high' });
  const target = await llm.resolveChatTarget({ chatId: 'chat-1' });
  assert.deepEqual(asked, ['chat-1']);
  assert.equal(target.reasoningEffort, 'high');
  assert.equal((await send(target)).reasoningEffort, 'high');

  // Without a chat id the adapter asks for the chat on screen.
  await llm.resolveChatTarget();
  assert.deepEqual(asked, ['chat-1', undefined]);
});

test('a chat without a level of its own runs with the default (#726)', async () => {
  // An entry's leftover level does not count any more.
  assert.equal((await levelAdapter({ entryLevel: 'low', own: null }).llm.resolveChatTarget()).reasoningEffort, 'medium');
  assert.equal((await levelAdapter({ own: null }).llm.resolveChatTarget()).reasoningEffort, 'medium');
  // A stored level the model does not take falls through as well.
  assert.equal((await levelAdapter({ entryLevel: 'low', own: 'max' }).llm.resolveChatTarget()).reasoningEffort, 'medium');
  // A history that cannot be read costs the level, not the round.
  assert.equal((await levelAdapter({ own: new Error('unreadable') }).llm.resolveChatTarget()).reasoningEffort, 'medium');
});

test('a model that takes no level gets none, not even one left in the stored config (#725)', async () => {
  const { llm, send } = levelAdapter({
    entryLevel: 'high',
    own: 'high',
    model: 'gpt-4o-mini',
    appliesTo: (model) => model.startsWith('gpt-5'),
    storedConfig: { reasoningEffort: 'high' },
  });
  const target = await llm.resolveChatTarget({ chatId: 'chat-1' });
  assert.equal(target.reasoningEffort, undefined);
  assert.equal('reasoningEffort' in (await send(target)), false);
});

test('a provider without levels gets none (#725)', async () => {
  const llm = createProviderLlmAdapter(makeAdapterDeps({
    llmConfigStore: { resolveChatModelTarget: () => ({ providerId: 'ollama', model: 'llama3' }) },
    reasoningLevelFor: async () => 'high',
  }));
  assert.equal((await llm.resolveChatTarget({ chatId: 'chat-1' })).reasoningEffort, undefined);
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
  assert.equal(sendErr.error.key, 'provider.error.noApiKeyFor.send');
  assert.equal(explainErr.code, 'NO_API_KEY');
  assert.equal(explainErr.error.key, 'provider.error.noApiKeyFor');
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
