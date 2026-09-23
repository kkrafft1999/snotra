const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../src/main/providers');
const {
  createProviderRuntimeAdapter,
  createProviderCatalogAdapter,
} = require('../src/main/adapters/provider-catalog-adapter');
const { createSettingsPresentationService } = require('../src/main/services/settings-presentation-service');
const { isMessage } = require('../src/shared/contracts/message');

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
      // A proper placeholder ("sk-…") or a catalogue message (#310).
      const placeholder = p.presentation.apiKeyPlaceholder;
      assert.ok(typeof placeholder === 'string' || isMessage(placeholder), `${id}: apiKeyPlaceholder`);
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
    locale: 'de',
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

// --- Verbindung je Eintrag (Issue #202) -----------------------------------

function compatPresetView(connection, { model = 'qwen2.5', apiKeyDecryptable } = {}) {
  const meta = providerCatalog.listProviderMeta().find((m) => m.id === 'openai-compatible');
  const providerView = presentation.buildProviderView(meta, {}, {});
  return presentation.buildPresetView(
    { id: 'p1', providerId: 'openai-compatible', model, menuVisible: true, connection },
    { 'openai-compatible': providerView },
    undefined,
    apiKeyDecryptable
  );
}

test('der Anzeigename der Zeile ersetzt den Anbieternamen in den Beschriftungen', () => {
  const preset = compatPresetView({ displayName: 'LM Studio', baseUrl: 'http://localhost:1234/v1' });
  assert.equal(preset.labelBase, 'LM Studio \u00b7 qwen2.5');
  assert.match(preset.sublabel, /localhost:1234/);
});

test('ohne Anzeigename bleibt es beim eingebauten Namen', () => {
  const preset = compatPresetView({ displayName: '   ', baseUrl: 'http://localhost:1234/v1' });
  assert.equal(preset.labelBase, 'OpenAI-compatible \u00b7 qwen2.5');
});

test('zwei Zeilen fuehren zwei verschiedene Ziele nebeneinander', () => {
  const gateway = compatPresetView(
    { displayName: 'Firmen-Gateway', baseUrl: 'https://gateway.firma.example/v1' },
    { model: 'gpt-4o-mini' }
  );
  const lokal = compatPresetView(
    { displayName: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
    { model: 'qwen2.5-coder' }
  );
  assert.equal(gateway.labelBase, 'Firmen-Gateway \u00b7 gpt-4o-mini');
  assert.equal(lokal.labelBase, 'LM Studio \u00b7 qwen2.5-coder');
  assert.notEqual(gateway.sublabel, lokal.sublabel);
  assert.match(gateway.sublabel, /gateway\.firma\.example/);
});

test('ein Eintrag mit Server-URL gilt ohne Schluessel als vollstaendig', () => {
  assert.equal(compatPresetView({ baseUrl: 'http://localhost:1234/v1' }).configured, true);
  assert.equal(compatPresetView({ baseUrl: '   ' }).configured, false);
});

test('ein unlesbarer Schluessel macht die Zeile unvollstaendig', () => {
  const preset = compatPresetView(
    { baseUrl: 'http://localhost:1234/v1', apiKeyEnc: 'Y2lwaGVy' },
    { apiKeyDecryptable: { 'preset:p1': false } }
  );
  assert.equal(preset.connection.keyUnreadable, true);
  assert.equal(preset.configured, false);
});

test('die Zeile meldet nur, OB Geheimnisse liegen - nie welche', () => {
  const preset = compatPresetView({
    baseUrl: 'x',
    apiKeyEnc: 'S0VZ',
    extraHeadersEnc: 'Y2lwaGVy',
  });
  assert.equal(preset.connection.hasKey, true);
  assert.equal(preset.connection.hasExtraHeaders, true);
  assert.equal('apiKeyEnc' in preset.connection, false);
  assert.equal('extraHeadersEnc' in preset.connection, false);
  assert.doesNotMatch(JSON.stringify(preset), /Y2lwaGVy|S0VZ/);
});

test('API-Stil und Schalter der Zeile kommen mit ihren Voreinstellungen heraus', () => {
  const fresh = compatPresetView({ baseUrl: 'x' });
  assert.equal(fresh.connection.apiStyle, 'chat');
  assert.equal(fresh.connection.sendTools, true);
  assert.equal(fresh.connection.supportsImages, false);

  const set = compatPresetView({
    baseUrl: 'x', apiStyle: 'full', sendTools: false, supportsImages: true,
  });
  assert.equal(set.connection.apiStyle, 'full');
  assert.equal(set.connection.sendTools, false);
  assert.equal(set.connection.supportsImages, true);
});

test('Eintraege der uebrigen Anbieter tragen keine eigene Verbindung', () => {
  const meta = providerCatalog.listProviderMeta().find((m) => m.id === 'ollama');
  const providerView = presentation.buildProviderView(meta, { baseUrl: 'http://127.0.0.1:11434' }, {});
  const preset = presentation.buildPresetView(
    { id: 'o1', providerId: 'ollama', model: 'llama3.2', menuVisible: true },
    { ollama: providerView }
  );
  assert.equal('connection' in preset, false);
  assert.equal(preset.labelBase, 'Ollama (local) \u00b7 llama3.2');
});

// #310: what a provider definition says reaches the renderer in the stored
// language — names, hints, option labels, templates and the connection line.
test('buildLlmStateDto speaks the stored language', () => {
  const config = {
    activeProvider: 'ollama',
    activePresetId: 'o1',
    presets: [{ id: 'o1', providerId: 'ollama', model: 'llama3.2', menuVisible: true }],
    providers: { ollama: { baseUrl: 'http://127.0.0.1:11434' } },
  };
  const build = (locale) => presentation.buildLlmStateDto({
    encryptionAvailable: true,
    config,
    chatTarget: { providerId: 'ollama', model: 'llama3.2' },
    locale,
  });
  const en = build('en');
  const de = build('de');
  const view = (dto, id) => dto.providers.find((p) => p.id === id);

  assert.equal(en.presets[0].labelBase, 'Ollama (local) · llama3.2');
  assert.equal(de.presets[0].labelBase, 'Ollama (lokal) · llama3.2');
  assert.match(en.presets[0].sublabel, /TLS verified/);
  assert.match(de.presets[0].sublabel, /TLS geprüft/);
  assert.equal(view(en, 'mlx-lm').name, 'MLX-LM (local)');
  assert.equal(view(de, 'openai-compatible').builtInName, 'OpenAI-kompatibel');

  const summaryEn = view(en, 'openai').presetFields.find((f) => f.key === 'reasoningSummary');
  const summaryDe = view(de, 'openai').presetFields.find((f) => f.key === 'reasoningSummary');
  assert.equal(summaryEn.label, 'Reasoning summary');
  assert.equal(summaryDe.label, 'Reasoning-Zusammenfassung');
  assert.deepEqual(summaryEn.options.map((o) => o.label), ['off', 'auto']);
  assert.deepEqual(summaryDe.options.map((o) => o.label), ['aus', 'auto']);

  const formEn = view(en, 'openai-compatible').form;
  const formDe = view(de, 'openai-compatible').form;
  assert.equal(formEn.apiKeyPlaceholder, 'leave empty if the server needs no key');
  assert.equal(formEn.displayNamePlaceholder, 'OpenAI-compatible');
  assert.deepEqual(formDe.apiStyleOptions.map((o) => o.label), ['Nur Chat Completions', 'Responses, sonst Chat Completions']);
  const customEn = formEn.templates.find((t) => t.id === 'custom');
  const lmStudioDe = formDe.templates.find((t) => t.id === 'lm-studio');
  assert.equal(customEn.label, 'Custom endpoint');
  assert.equal(lmStudioDe.label, 'LM Studio');
  assert.equal(lmStudioDe.hint, 'Lokaler Server von LM Studio, ohne API-Key.');
  // Nothing in the views is left as a descriptor.
  assert.equal(JSON.stringify(en).includes('"key":"provider.'), false);
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
