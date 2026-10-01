'use strict';

const { createListModelsResult } = require('../../shared/contracts/settings');
const { createMessage } = require('../../shared/contracts/message');

/** A base URL as the providers build it: trimmed, without a trailing slash. */
function normalizeBaseUrl(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

function createProviderModelListingAdapter({ providerRuntime, providerSecrets }) {
  return {
    async listModels(providerId, request) {
      const provider = providerRuntime.getProvider(providerId);
      if (!provider || typeof provider.listModels !== 'function') {
        return createListModelsResult({ error: createMessage('settings.error.provider.unknown') });
      }

      // Bei `connectionPerPreset` liegt die gespeicherte Verbindung am Eintrag
      // (Issue #202); `presetId` sagt, an welchem.
      const stored = (await providerSecrets.getEffectiveProviderConfig(providerId, {
        presetId: request.presetId,
      })) || {};
      // A stored secret goes only to the endpoint it was stored with (#537).
      // A provider without a URL field talks to its own base, whatever the
      // request names; for the others a draft URL that differs from the stored
      // one gets only what the request itself brings — the renderer is not a
      // security boundary and must not be able to point a stored key elsewhere.
      const storedBaseUrl = normalizeBaseUrl(stored.baseUrl || provider.defaultBaseUrl);
      const requestedBaseUrl = provider.fields?.baseUrl ? normalizeBaseUrl(request.baseUrl) : '';
      const sameEndpoint = !requestedBaseUrl || requestedBaseUrl === storedBaseUrl;
      const config = {
        signal: request.signal,
        apiKey: request.apiKey || (sameEndpoint ? stored.apiKey : '') || '',
        baseUrl: requestedBaseUrl || storedBaseUrl,
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
        : (sameEndpoint ? stored.extraHeaders : undefined);
      if (typeof extraHeaders === 'string' && extraHeaders) {
        config.extraHeaders = extraHeaders;
      }

      try {
        const result = await provider.listModels(config);
        if (result?.error) return createListModelsResult({ error: result.error });
        return createListModelsResult({ models: result?.models });
      } catch (err) {
        return createListModelsResult({ error: err.message || createMessage('addModel.models.loadFailed') });
      }
    },
  };
}

module.exports = {
  createProviderModelListingAdapter,
};
