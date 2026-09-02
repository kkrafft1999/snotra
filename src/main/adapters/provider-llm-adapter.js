'use strict';

const { CHAT_ERROR_CODES, createChatErrorResult } = require('../../shared/contracts');
const { createChatModelTarget } = require('../../shared/contracts/llm-target');
const { describeFetchError } = require('../../shared/runtime/fetch-errors');
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
      model,
      providerOptions,
    });
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

  async function resolveChatTarget() {
    const config = await llmConfigStore.readLLMConfig();
    const raw = llmConfigStore.resolveChatModelTarget(config);
    const provider = providerRuntime.getProvider(raw.providerId);
    if (!provider) {
      return createChatErrorResult({
        error: `Unbekannter Provider: ${raw.providerId}.`,
        code: CHAT_ERROR_CODES.INVALID,
      });
    }
    return toTarget(raw);
  }

  async function validateTarget(target, { forSend = false } = {}) {
    const provider = providerRuntime.getProvider(target.providerId);
    if (!provider) {
      return createChatErrorResult({
        error: `Unbekannter Provider: ${target.providerId}.`,
        code: CHAT_ERROR_CODES.INVALID,
      });
    }

    const providerConfig = await providerSecrets.getEffectiveProviderConfig(target.providerId);
    if (provider.fields?.apiKey && !providerConfig?.apiKey) {
      const suffix = forSend ? ' Bitte in den Einstellungen speichern.' : '';
      return createChatErrorResult({
        error: `Kein API-Key für ${provider.name} hinterlegt.${suffix}`,
        code: CHAT_ERROR_CODES.NO_API_KEY,
      });
    }
    if (provider.fields?.baseUrl && !providerConfig?.baseUrl) {
      return createChatErrorResult({
        error: `Keine Server-URL für ${provider.name} hinterlegt.`,
        code: CHAT_ERROR_CODES.NO_BASE_URL,
      });
    }
    return null;
  }

  async function prepareSendBundle(target) {
    const provider = providerRuntime.getProvider(target.providerId);
    const baseConfig = await providerSecrets.getEffectiveProviderConfig(target.providerId);
    const config = mergeProviderConfig(baseConfig, target, provider);
    const model = resolveModel(target, provider, baseConfig);
    return { config, model };
  }

  async function streamRound({
    target,
    messages,
    tools,
    callbacks,
    abortSignal,
    sendBundle,
  }) {
    const provider = providerRuntime.getProvider(target.providerId);
    let config;
    let model;
    if (sendBundle) {
      config = sendBundle.config;
      model = sendBundle.model;
    } else {
      const baseConfig = await providerSecrets.getEffectiveProviderConfig(target.providerId);
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
    });
  }

  function formatRoundError(err) {
    return describeFetchError(err, 'dem Provider');
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
