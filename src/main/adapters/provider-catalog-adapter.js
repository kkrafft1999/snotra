'use strict';

function toCatalogEntry(provider) {
  if (!provider) return null;
  return {
    id: provider.id,
    name: provider.name,
    defaultModel: provider.defaultModel || '',
    defaultBaseUrl: provider.defaultBaseUrl || '',
    defaultInsecureTls: provider.defaultInsecureTls === true,
    // Voreinstellungen der Felder aus Issue #193; ohne sie faende
    // `getEffectiveProviderConfig` hinter dem Katalog-Adapter keinen Default.
    defaultApiStyle: provider.defaultApiStyle || '',
    defaultSupportsImages: provider.defaultSupportsImages === true,
    defaultSendTools: provider.defaultSendTools !== false,
    fields: provider.fields || {},
    presentation: provider.presentation,
    apiBase: provider.apiBase || '',
    capabilities: { images: provider.capabilities?.images === true },
    optionalApiKey: provider.optionalApiKey === true,
    // Faehigkeiten, die an der gespeicherten Konfiguration haengen statt am
    // Adapter (Issue #193) — die Praesentation ruft sie mit dem Eintrag auf.
    ...(typeof provider.capabilitiesFor === 'function'
      ? { capabilitiesFor: provider.capabilitiesFor }
      : {}),
  };
}

function createProviderRuntimeAdapter(providersModule) {
  return {
    getProvider(id) {
      return providersModule.getProvider(id);
    },
    listProviderMeta() {
      return providersModule.listProviderMeta();
    },
    disposeAll() {
      return providersModule.disposeAll();
    },
  };
}

function createProviderCatalogAdapter(providerRuntime) {
  return {
    exists(id) {
      return !!providerRuntime.getProvider(id);
    },
    getProvider(id) {
      return toCatalogEntry(providerRuntime.getProvider(id));
    },
    listProviderMeta() {
      return providerRuntime.listProviderMeta().map((meta) => {
        const entry = toCatalogEntry(providerRuntime.getProvider(meta.id));
        return entry || meta;
      });
    },
  };
}

module.exports = {
  toCatalogEntry,
  createProviderRuntimeAdapter,
  createProviderCatalogAdapter,
};
