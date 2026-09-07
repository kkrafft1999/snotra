'use strict';

const { createListModelsResult } = require('../../shared/contracts/settings');

function createProviderModelListingAdapter({ providerRuntime, providerSecrets }) {
  return {
    async listModels(providerId, request) {
      const provider = providerRuntime.getProvider(providerId);
      if (!provider || typeof provider.listModels !== 'function') {
        return createListModelsResult({ error: 'Unbekannter Provider.' });
      }

      const stored = (await providerSecrets.getEffectiveProviderConfig(providerId)) || {};
      const config = {
        signal: request.signal,
        apiKey: request.apiKey || stored.apiKey || '',
        baseUrl: request.baseUrl || stored.baseUrl || provider.defaultBaseUrl || '',
        insecureTls: typeof request.insecureTls === 'boolean'
          ? request.insecureTls
          : (typeof stored.insecureTls === 'boolean'
              ? stored.insecureTls
              : provider.defaultInsecureTls === true),
      };

      try {
        const result = await provider.listModels(config);
        if (result?.error) return createListModelsResult({ error: result.error });
        return createListModelsResult({ models: result?.models });
      } catch (err) {
        return createListModelsResult({ error: err.message || 'Modelle konnten nicht geladen werden.' });
      }
    },
  };
}

module.exports = {
  createProviderModelListingAdapter,
};
