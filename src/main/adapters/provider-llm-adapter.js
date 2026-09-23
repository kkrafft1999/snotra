'use strict';

const { CHAT_ERROR_CODES, createChatErrorResult } = require('../../shared/contracts');
const { createChatModelTarget } = require('../../shared/contracts/llm-target');
const { createMessage } = require('../../shared/contracts/message');
const { describeFetchErrorMessage } = require('../../shared/runtime/fetch-errors');
const {
  extractPresetOptions,
  filterDeclaredPresetOptions,
} = require('../../shared/contracts/settings');

function createProviderLlmAdapter({ providerRuntime, llmConfigStore, providerSecrets }) {
  function resolveProviderOptions(raw, provider) {
    if (raw.providerOptions && typeof raw.providerOptions === 'object') {
      return filterDeclaredPresetOptions(raw.providerOptions, provider);
    }
    return filterDeclaredPresetOptions(extractPresetOptions(raw, provider), provider);
  }

  function toTarget(raw) {
    const provider = providerRuntime.getProvider(raw.providerId);
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    const providerOptions = resolveProviderOptions(raw, provider);
    return createChatModelTarget({
      providerId: raw.providerId,
      // Bei `connectionPerPreset` haengt die Verbindung am Eintrag; ohne die
      // Kennung koennte sie hier niemand mehr aufloesen (Issue #202).
      presetId: raw.presetId,
      model,
      providerOptions,
    });
  }

  /** Verbindungsquelle einer Runde: der Eintrag, sonst der Anbieter. */
  function scopeOf(target) {
    return target?.presetId ? { presetId: target.presetId } : {};
  }

  function mergeProviderConfig(baseConfig, target, provider) {
    const opts = filterDeclaredPresetOptions(target.providerOptions, provider);
    if (!opts) return { ...(baseConfig || {}) };
    const merged = { ...(baseConfig || {}) };
    for (const [key, value] of Object.entries(opts)) {
      merged[key] = value;
    }
    return merged;
  }

  function resolveModel(target, provider, baseConfig) {
    return target.model || baseConfig?.model || provider.defaultModel;
  }

  function providerDisplayName(provider, config) {
    const custom = typeof config?.displayName === 'string' ? config.displayName.trim() : '';
    return custom || provider.name;
  }

  async function resolveChatTarget() {
    const config = await llmConfigStore.readLLMConfig();
    const raw = llmConfigStore.resolveChatModelTarget(config);
    const provider = providerRuntime.getProvider(raw.providerId);
    if (!provider) {
      return createChatErrorResult({
        error: createMessage('provider.error.unknown', { id: raw.providerId }),
        code: CHAT_ERROR_CODES.INVALID,
      });
    }
    return toTarget(raw);
  }

  async function validateTarget(target, { forSend = false } = {}) {
    const provider = providerRuntime.getProvider(target.providerId);
    if (!provider) {
      return createChatErrorResult({
        error: createMessage('provider.error.unknown', { id: target.providerId }),
        code: CHAT_ERROR_CODES.INVALID,
      });
    }

    const providerConfig = await providerSecrets.getEffectiveProviderConfig(
      target.providerId,
      scopeOf(target)
    );
    // Ein Anbieter mit optionalem Key (Issue #193) darf ohne Key laufen — ein
    // lokaler Server verlangt keinen.
    if (provider.fields?.apiKey && provider.optionalApiKey !== true && !providerConfig?.apiKey) {
      return createChatErrorResult({
        error: forSend
          ? createMessage('provider.error.noApiKeyFor.send', { provider: provider.name })
          : createMessage('provider.error.noApiKeyFor', { provider: provider.name }),
        code: CHAT_ERROR_CODES.NO_API_KEY,
      });
    }
    if (provider.fields?.baseUrl && !providerConfig?.baseUrl) {
      return createChatErrorResult({
        error: createMessage('provider.error.noBaseUrlFor', { provider: provider.name }),
        code: CHAT_ERROR_CODES.NO_BASE_URL,
      });
    }
    return null;
  }

  async function prepareSendBundle(target) {
    const provider = providerRuntime.getProvider(target.providerId);
    const baseConfig = await providerSecrets.getEffectiveProviderConfig(
      target.providerId,
      scopeOf(target)
    );
    const config = mergeProviderConfig(baseConfig, target, provider);
    const model = resolveModel(target, provider, baseConfig);
    return {
      config,
      model,
      // Der Anzeigename gehoert in jede Meldung, die den Anbieter nennt —
      // sonst steht „OpenAI-kompatibel" da, wo der Nutzer „LM Studio" sieht.
      providerName: providerDisplayName(provider, config),
      capabilities: typeof provider.capabilitiesFor === 'function'
        ? { images: provider.capabilitiesFor(config)?.images === true }
        : { images: provider.capabilities?.images === true },
    };
  }

  /**
   * `cacheKey` bindet die Runde an einen Prompt-Cache (Issue #179). Ohne ihn
   * verteilt OpenAI die Anfragen frei auf seine Maschinen, und ein Chat trifft
   * mal auf einen warmen und mal auf einen kalten Cache. Nur OpenAI wertet ihn
   * aus; die uebrigen Provider ignorieren das Feld.
   */
  async function streamRound({
    target,
    messages,
    tools,
    callbacks,
    abortSignal,
    sendBundle,
    cacheKey,
  }) {
    const provider = providerRuntime.getProvider(target.providerId);
    let config;
    let model;
    if (sendBundle) {
      config = sendBundle.config;
      model = sendBundle.model;
    } else {
      const baseConfig = await providerSecrets.getEffectiveProviderConfig(
        target.providerId,
        scopeOf(target)
      );
      config = mergeProviderConfig(baseConfig, target, provider);
      model = resolveModel(target, provider, baseConfig);
    }
    return provider.streamChatRound({
      config,
      model,
      messages,
      tools,
      callbacks,
      abortSignal,
      cacheKey,
    });
  }

  // Which provider it was is in the bubble already; the sentence names none.
  function formatRoundError(err) {
    return describeFetchErrorMessage(err);
  }

  return {
    resolveChatTarget,
    validateTarget,
    prepareSendBundle,
    streamRound,
    formatRoundError,
  };
}

module.exports = {
  createProviderLlmAdapter,
};
