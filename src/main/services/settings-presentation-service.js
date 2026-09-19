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
    // Bei optionalem Key (Issue #193) entscheidet die Server-URL: „kein Key" ist
    // dort der Normalfall eines lokalen Servers, kein unvollstaendiger Zugang.
    const needsKey = meta.fields?.apiKey && meta.optionalApiKey !== true;
    const configured = needsKey
      ? hasKey && !keyUnreadable
      : meta.fields?.baseUrl
        ? !!String(baseUrl).trim()
        : true;
    const insecureTls = meta.fields?.insecureTls
      ? (typeof entry.insecureTls === 'boolean' ? entry.insecureTls : meta.defaultInsecureTls === true)
      : false;
    return { hasKey, keyUnreadable, baseUrl, configured, insecureTls };
  }

  /**
   * Felder des Providers „OpenAI-kompatibel" (Issue #193) fuer die Oberflaeche.
   * Die Zusatz-Header sind ein Geheimnis: Die View sagt nur, **ob** welche
   * gespeichert sind — der Inhalt verlaesst den Main-Prozess nie.
   */
  function resolveExtendedFields(meta, entry) {
    const out = {};
    if (meta.fields?.displayName) {
      out.displayName = typeof entry.displayName === 'string' ? entry.displayName : '';
    }
    if (meta.fields?.apiStyle) {
      out.apiStyle = typeof entry.apiStyle === 'string' && entry.apiStyle
        ? entry.apiStyle
        : (meta.defaultApiStyle || 'chat');
    }
    if (meta.fields?.extraHeaders) {
      out.hasExtraHeaders = typeof entry.extraHeadersEnc === 'string' && entry.extraHeadersEnc.length > 0;
    }
    if (meta.fields?.supportsImages) {
      out.supportsImages = typeof entry.supportsImages === 'boolean'
        ? entry.supportsImages
        : meta.defaultSupportsImages === true;
    }
    if (meta.fields?.sendTools) {
      out.sendTools = typeof entry.sendTools === 'boolean'
        ? entry.sendTools
        : meta.defaultSendTools !== false;
    }
    return out;
  }

  function buildProviderView(meta, entry, { chatProviderId, apiKeyDecryptable } = {}) {
    const provider = getProvider(meta.id) || meta;
    const { hasKey, keyUnreadable, baseUrl, configured, insecureTls } = resolveConfigured(meta, entry, apiKeyDecryptable);
    const model = entry.model || meta.defaultModel || '';
    const extended = resolveExtendedFields(meta, entry);
    // Der Anzeigename steht ueberall dort, wo sonst der Anbietername steht —
    // im Modell-Picker, in der Pille und in der Kopfzeile des Chats. Bei
    // wechselnden Zielen ist das die einzige Stelle, an der man sieht, mit wem
    // man spricht (Issue #193).
    const name = typeof extended.displayName === 'string' && extended.displayName.trim()
      ? extended.displayName.trim()
      : meta.name;
    // Bild-Faehigkeit kann an der Konfiguration haengen statt am Adapter.
    const capabilities = typeof provider?.capabilitiesFor === 'function'
      ? { images: provider.capabilitiesFor(entry)?.images === true }
      : { images: meta.capabilities?.images === true };

    return {
      id: meta.id,
      name,
      // Der fest eingebaute Name bleibt sichtbar, damit das Formular ihn als
      // Rueckfall anzeigen kann, wenn der Anzeigename leer ist.
      builtInName: meta.name,
      ...extended,
      defaultModel: meta.defaultModel || '',
      defaultBaseUrl: meta.defaultBaseUrl || '',
      defaultInsecureTls: meta.defaultInsecureTls === true,
      apiBase: meta.apiBase || '',
      // Bild-Anhaenge (Issue #93): Der Composer lehnt sie ab, wenn der aktive
      // Anbieter sie nicht weiterreicht.
      capabilities,
      optionalApiKey: meta.optionalApiKey === true,
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
