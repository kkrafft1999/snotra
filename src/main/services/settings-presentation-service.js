'use strict';

const {
  formatPresetSublabelFromView,
  formatPresetOptionSuffixFromView,
  buildPresetFieldViews,
  buildProviderFormView,
} = require('../../shared/contracts/settings');

function createSettingsPresentationService({ providerCatalog, defaultProviderId }) {
  function getProvider(id) {
    return providerCatalog.getProvider(id);
  }

  // apiKeyDecryptable: { [providerId]: boolean } aus dem Handler; fehlt der
  // Eintrag (z. B. aeltere Aufrufer), gilt ein gespeicherter Key als lesbar.
  function resolveConfigured(meta, entry, apiKeyDecryptable) {
    const hasKey = meta.fields?.apiKey ? !!entry.apiKeyEnc : false;
    const keyUnreadable = hasKey && apiKeyDecryptable?.[meta.id] === false;
    const baseUrl = meta.fields?.baseUrl ? (entry.baseUrl || meta.defaultBaseUrl || '') : '';
    const configured = meta.fields?.apiKey
      ? hasKey && !keyUnreadable
      : meta.fields?.baseUrl
        ? !!String(baseUrl).trim()
        : true;
    const insecureTls = meta.fields?.insecureTls
      ? (typeof entry.insecureTls === 'boolean' ? entry.insecureTls : meta.defaultInsecureTls === true)
      : false;
    return { hasKey, keyUnreadable, baseUrl, configured, insecureTls };
  }

  function buildProviderView(meta, entry, { chatProviderId, apiKeyDecryptable } = {}) {
    const provider = getProvider(meta.id) || meta;
    const { hasKey, keyUnreadable, baseUrl, configured, insecureTls } = resolveConfigured(meta, entry, apiKeyDecryptable);
    const model = entry.model || meta.defaultModel || '';

    return {
      id: meta.id,
      name: meta.name,
      defaultModel: meta.defaultModel || '',
      defaultBaseUrl: meta.defaultBaseUrl || '',
      defaultInsecureTls: meta.defaultInsecureTls === true,
      apiBase: meta.apiBase || '',
      configured,
      hasKey,
      keyUnreadable,
      model,
      baseUrl,
      insecureTls,
      isActiveChatProvider: meta.id === chatProviderId,
      connectionDetail: !!(getProvider(meta.id)?.presentation?.connectionDetail),
      form: buildProviderFormView(provider),
      presetFields: buildPresetFieldViews(provider),
    };
  }

  function buildPresetView(preset, providerViewsById, connectionOverrides) {
    const providerView = providerViewsById[preset.providerId];
    if (!providerView) return null;

    const connection = connectionOverrides?.[preset.providerId];
    const sublabel = formatPresetSublabelFromView(preset, providerView, connection);
    // Zusatz wie das Reasoning-Level haengt hinter dem Modell, damit Chat-Menue
    // und Pille einzeilig bleiben: „OpenAI · gpt-5 · high“.
    const optionSuffix = formatPresetOptionSuffixFromView(preset, providerView);
    const base = `${providerView.name} · ${preset.model || providerView.defaultModel}`;
    const label = optionSuffix ? `${base} · ${optionSuffix}` : base;

    return {
      id: preset.id,
      providerId: preset.providerId,
      model: preset.model,
      menuVisible: preset.menuVisible !== false,
      label,
      labelBase: base,
      optionSuffix,
      sublabel: sublabel.text,
      sublabelStyle: sublabel.style,
      configured: providerView.configured,
      ...extractPresetOptionFields(preset, getProvider(preset.providerId)),
    };
  }

  function extractPresetOptionFields(preset, provider) {
    const fields = provider?.presentation?.presetFields;
    if (!Array.isArray(fields)) return {};
    const out = {};
    for (const field of fields) {
      if (!field?.key) continue;
      const value = preset[field.key];
      if (typeof value === 'string' && value) {
        out[field.key] = value;
      }
    }
    return out;
  }

  function buildLlmStateDto({
    encryptionAvailable,
    config,
    chatTarget,
    connectionOverrides,
    apiKeyDecryptable,
  }) {
    const active = config.activeProvider || defaultProviderId;
    const providerMetaList = providerCatalog.listProviderMeta();
    const providerViews = providerMetaList.map((meta) => {
      const entry = (config.providers && config.providers[meta.id]) || {};
      return buildProviderView(meta, entry, {
        chatProviderId: chatTarget.providerId,
        apiKeyDecryptable,
      });
    });
    const providerViewsById = Object.fromEntries(providerViews.map((p) => [p.id, p]));

    const presetsWire = Array.isArray(config.presets) ? config.presets : [];
    const presets = presetsWire
      .map((row) => buildPresetView(row, providerViewsById, connectionOverrides))
      .filter(Boolean);

    return {
      encryptionAvailable,
      activeProvider: active,
      activePresetId: config.activePresetId || null,
      chatTarget,
      presets,
      providers: providerViews,
    };
  }

  return {
    buildLlmStateDto,
    buildProviderView,
    buildPresetView,
  };
}

module.exports = {
  createSettingsPresentationService,
};
