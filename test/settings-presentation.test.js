const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../src/main/providers');
const {
  createProviderRuntimeAdapter,
  createProviderCatalogAdapter,
} = require('../src/main/adapters/provider-catalog-adapter');
const { createSettingsPresentationService } = require('../src/main/services/settings-presentation-service');

const providerCatalog = createProviderCatalogAdapter(createProviderRuntimeAdapter(providers));

const presentation = createSettingsPresentationService({
  providerCatalog,
  defaultProviderId: 'openai',
});

test('every registered provider exposes presentation metadata', () => {
  for (const id of providers.PROVIDER_ORDER) {
    const p = providers.getProvider(id);
    assert.ok(p.presentation, `${id} must define presentation`);
    if (p.fields?.apiKey) {
      assert.equal(typeof p.presentation.apiKeyPlaceholder, 'string');
    }
    if (p.fields?.baseUrl) {
      assert.equal(typeof p.presentation.baseUrlPlaceholder, 'string');
      assert.equal(p.presentation.connectionDetail, true);
    }
  }
});

test('buildLlmStateDto returns normalized preset and provider views', () => {
  const dto = presentation.buildLlmStateDto({
    encryptionAvailable: true,
    config: {
      activeProvider: 'openai',
      activePresetId: 'p1',
      presets: [
        {
          id: 'p1',
          providerId: 'openai',
          model: 'gpt-4o-mini',
          reasoningEffort: 'medium',
          menuVisible: true,
        },
        {
          id: 'p2',
          providerId: 'ollama',
          model: 'llama3.2',
          menuVisible: true,
        },
      ],
      providers: {
        openai: { apiKeyEnc: 'abc', model: 'gpt-4o-mini' },
        ollama: { baseUrl: 'http://127.0.0.1:11434' },
      },
    },
    chatTarget: {
      providerId: 'openai',
      model: 'gpt-4o-mini',
      reasoningEffort: 'medium',
    },
  });

  assert.equal(dto.encryptionAvailable, true);
  assert.equal(dto.activePresetId, 'p1');
  assert.equal(dto.presets.length, 2);

  const openaiPreset = dto.presets.find((p) => p.id === 'p1');
  // Das Reasoning-Level haengt hinter dem Modell, damit Chat-Pille und
  // Chat-Menue einzeilig bleiben; labelBase/optionSuffix trennen die Teile.
  assert.equal(openaiPreset.label, 'OpenAI · gpt-4o-mini · medium');
  assert.equal(openaiPreset.labelBase, 'OpenAI · gpt-4o-mini');
  assert.equal(openaiPreset.optionSuffix, 'medium');
  assert.equal(openaiPreset.sublabel, 'medium');
  assert.equal(openaiPreset.sublabelStyle, 'mono');
  assert.equal(openaiPreset.configured, true);

  const ollamaPreset = dto.presets.find((p) => p.id === 'p2');
  // Provider ohne Suffix-Feld: Label bleibt unveraendert, kein Zusatz.
  assert.equal(ollamaPreset.optionSuffix, '');
  assert.equal(ollamaPreset.label, ollamaPreset.labelBase);
  assert.match(ollamaPreset.sublabel, /Server: 127\.0\.0\.1:11434/);
  assert.match(ollamaPreset.sublabel, /TLS geprüft/);

  const openaiProvider = dto.providers.find((p) => p.id === 'openai');
  assert.equal(openaiProvider.form.showApiKey, true);
  assert.equal(openaiProvider.form.apiKeyPlaceholder, 'sk-…');
  assert.equal(openaiProvider.presetFields.length, 2);
  assert.equal(openaiProvider.presetFields[0].key, 'reasoningEffort');
  assert.equal(openaiProvider.presetFields[1].key, 'reasoningSummary');
  assert.equal(openaiProvider.isActiveChatProvider, true);
  assert.equal(openaiProvider.fields, undefined);

  const ollamaProvider = dto.providers.find((p) => p.id === 'ollama');
  assert.equal(ollamaProvider.form.showBaseUrl, true);
  assert.equal(ollamaProvider.connectionDetail, true);
  assert.equal(ollamaProvider.fields, undefined);

  // Der Composer liest die Bild-Faehigkeit aus dieser Sicht (Issue #93).
  assert.equal(openaiProvider.capabilities.images, true);
  assert.equal(ollamaProvider.capabilities.images, false);
});

test('buildPresetView respects connection draft overrides', () => {
  const providerViewsById = {
    ollama: {
      id: 'ollama',
      name: 'Ollama (lokal)',
      defaultModel: 'llama3.2',
      baseUrl: 'http://127.0.0.1:11434',
      insecureTls: false,
      configured: true,
      connectionDetail: true,
    },
  };
  const view = presentation.buildPresetView(
    { id: 'p1', providerId: 'ollama', model: 'llama3.2', menuVisible: true },
    providerViewsById,
    { ollama: { baseUrl: 'https://draft.local', insecureTls: true } }
  );
  assert.match(view.sublabel, /draft\.local/);
  assert.match(view.sublabel, /TLS insecure/);
});

test('a stored but undecryptable API key marks provider and presets as not configured', () => {
  const build = (apiKeyDecryptable) => presentation.buildLlmStateDto({
    encryptionAvailable: true,
    config: {
      version: 3,
      activeProvider: 'openai',
      activePresetId: 'p1',
      presets: [{ id: 'p1', providerId: 'openai', model: 'gpt-4o-mini', menuVisible: true }],
      providers: { openai: { apiKeyEnc: 'abc', model: 'gpt-4o-mini' } },
    },
    chatTarget: { providerId: 'openai', model: 'gpt-4o-mini' },
    apiKeyDecryptable,
  });

  const broken = build({ openai: false });
  const brokenProvider = broken.providers.find((p) => p.id === 'openai');
  assert.equal(brokenProvider.hasKey, true, 'Key ist gespeichert');
  assert.equal(brokenProvider.keyUnreadable, true);
  assert.equal(brokenProvider.configured, false);
  assert.equal(broken.presets.find((p) => p.id === 'p1').configured, false);

  const fine = build({ openai: true });
  const fineProvider = fine.providers.find((p) => p.id === 'openai');
  assert.equal(fineProvider.keyUnreadable, false);
  assert.equal(fineProvider.configured, true);

  const legacyCaller = build(undefined);
  assert.equal(legacyCaller.providers.find((p) => p.id === 'openai').configured, true, 'ohne Map wie bisher');
});

// --- Provider „OpenAI-kompatibel" (Issue #193) ----------------------------

function compatView(entry) {
  const meta = providerCatalog.listProviderMeta().find((m) => m.id === 'openai-compatible');
  return presentation.buildProviderView(meta, entry, { chatProviderId: 'openai' });
}

test('ohne API-Key gilt der generische Anbieter mit Server-URL als konfiguriert', () => {
  const view = compatView({ baseUrl: 'http://localhost:1234/v1' });
  assert.equal(view.configured, true);
  assert.equal(view.hasKey, false);
  assert.equal(view.optionalApiKey, true);
  assert.equal(view.form.apiKeyOptional, true);
});

test('der Anzeigename ersetzt den Anbieternamen in allen Beschriftungen', () => {
  const view = compatView({ baseUrl: 'http://localhost:1234/v1', displayName: '  LM Studio  ' });
  assert.equal(view.name, 'LM Studio');
  assert.equal(view.builtInName, 'OpenAI-kompatibel');

  const preset = presentation.buildPresetView(
    { id: 'p', providerId: 'openai-compatible', model: 'qwen2.5', menuVisible: true },
    { 'openai-compatible': view }
  );
  assert.equal(preset.labelBase, 'LM Studio · qwen2.5');
});

test('ohne Anzeigename bleibt es beim eingebauten Namen', () => {
  const view = compatView({ baseUrl: 'http://localhost:1234/v1', displayName: '   ' });
  assert.equal(view.name, 'OpenAI-kompatibel');
});

test('die Bild-Faehigkeit folgt dem gespeicherten Schalter, nicht dem Adapter', () => {
  assert.equal(compatView({ baseUrl: 'x' }).capabilities.images, false);
  assert.equal(compatView({ baseUrl: 'x', supportsImages: true }).capabilities.images, true);
});

test('die View sagt nur, OB Zusatz-Header liegen — nie welche', () => {
  const view = compatView({ baseUrl: 'x', extraHeadersEnc: 'Y2lwaGVy' });
  assert.equal(view.hasExtraHeaders, true);
  assert.equal('extraHeaders' in view, false);
  assert.equal('extraHeadersEnc' in view, false);
  assert.doesNotMatch(JSON.stringify(view), /Y2lwaGVy/);
});

test('API-Stil und Tool-Schalter kommen mit ihren Voreinstellungen heraus', () => {
  const fresh = compatView({ baseUrl: 'x' });
  assert.equal(fresh.apiStyle, 'chat');
  assert.equal(fresh.sendTools, true);
  assert.equal(fresh.supportsImages, false);

  const set = compatView({ baseUrl: 'x', apiStyle: 'full', sendTools: false });
  assert.equal(set.apiStyle, 'full');
  assert.equal(set.sendTools, false);
});

test('das Formular meldet alle acht Felder und die Vorlagen', () => {
  const form = compatView({ baseUrl: 'x' }).form;
  assert.deepEqual(
    {
      showApiKey: form.showApiKey,
      showBaseUrl: form.showBaseUrl,
      showInsecureTls: form.showInsecureTls,
      showDisplayName: form.showDisplayName,
      showApiStyle: form.showApiStyle,
      showExtraHeaders: form.showExtraHeaders,
      showSupportsImages: form.showSupportsImages,
      showSendTools: form.showSendTools,
    },
    {
      showApiKey: true,
      showBaseUrl: true,
      showInsecureTls: true,
      showDisplayName: true,
      showApiStyle: true,
      showExtraHeaders: true,
      showSupportsImages: true,
      showSendTools: true,
    }
  );
  assert.equal(form.allowManualModel, true);
  assert.ok(form.templates.length >= 7);
  assert.ok(form.templates.every((tpl) => tpl.id && tpl.label && ['chat', 'full'].includes(tpl.apiStyle)));
});

test('die bestehenden Anbieter zeigen keines der neuen Felder', () => {
  for (const id of ['openai', 'anthropic', 'google', 'ollama', 'mlx-lm']) {
    const meta = providerCatalog.listProviderMeta().find((m) => m.id === id);
    const view = presentation.buildProviderView(meta, {}, {});
    assert.equal(view.form.showDisplayName, false, id);
    assert.equal(view.form.showApiStyle, false, id);
    assert.equal(view.form.showExtraHeaders, false, id);
    assert.equal(view.form.showSupportsImages, false, id);
    assert.equal(view.form.showSendTools, false, id);
    assert.equal(view.form.allowManualModel, false, id);
    assert.deepEqual(view.form.templates, [], id);
    assert.equal(view.optionalApiKey, false, id);
  }
});
