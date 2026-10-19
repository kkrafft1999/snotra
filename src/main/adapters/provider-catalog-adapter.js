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
    // The declaration (#996); the presentation resolves it against an entry.
    capabilities: provider.capabilities || {},
    optionalApiKey: provider.optionalApiKey === true,
    connectionPerPreset: provider.connectionPerPreset === true,
    // The reasoning levels a chat can choose, and for which models (#725).
    ...(provider.reasoning ? { reasoning: provider.reasoning } : {}),
  };
}

/**
 * @returns {import('../ports/provider-runtime-port').ProviderRuntimePort}
 */
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

/**
 * @returns {import('../ports/provider-catalog-port').ProviderCatalogPort}
 */
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
