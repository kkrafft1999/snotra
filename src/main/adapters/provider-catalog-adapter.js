'use strict';

function toCatalogEntry(provider) {
  if (!provider) return null;
  return {
    id: provider.id,
    name: provider.name,
    defaultModel: provider.defaultModel || '',
    defaultBaseUrl: provider.defaultBaseUrl || '',
    defaultInsecureTls: provider.defaultInsecureTls === true,
    fields: provider.fields || {},
    presentation: provider.presentation,
    apiBase: provider.apiBase || '',
    capabilities: { images: provider.capabilities?.images === true },
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
