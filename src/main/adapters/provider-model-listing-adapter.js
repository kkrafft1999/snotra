'use strict';

const { createListModelsResult } = require('../../shared/contracts/settings');

function createProviderModelListingAdapter({ providerRuntime, providerSecrets }) {
  return {
    async listModels(providerId, request) {
      const provider = providerRuntime.getProvider(providerId);
      if (!provider || typeof provider.listModels !== 'function') {
        return createListModelsResult({ error: 'Unbekannter Provider.' });
      }

      // Bei `connectionPerPreset` liegt die gespeicherte Verbindung am Eintrag
      // (Issue #202); `presetId` sagt, an welchem.
      const stored = (await providerSecrets.getEffectiveProviderConfig(providerId, {
        presetId: request.presetId,
      })) || {};
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
      // Zusatz-Header gehoeren zur Verbindung und muessen auch beim Abruf der
      // Modellliste mit (Issue #193). Frisch getippte kommen aus dem Request,
      // sonst aus dem verschluesselten Speicher — der Renderer kennt die
      // gespeicherten nie.
      const extraHeaders = typeof request.extraHeaders === 'string' && request.extraHeaders.trim()
        ? request.extraHeaders
        : stored.extraHeaders;
      if (typeof extraHeaders === 'string' && extraHeaders) {
        config.extraHeaders = extraHeaders;
      }

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
