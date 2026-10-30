'use strict';

const { CHAT_ERROR_CODES, createChatErrorResult } = require('../../shared/contracts');
const { createChatModelTarget } = require('../../shared/contracts/llm-target');
const { createMessage } = require('../../shared/contracts/message');
const { describeFetchErrorMessage } = require('../../shared/runtime/fetch-errors');
const {
  extractPresetOptions,
  filterDeclaredPresetOptions,
  storedConnectionFor,
} = require('../../shared/contracts/settings');
const { reasoningDefaultFor, reasoningLevelsFor, resolveReasoningLevel } = require('../../shared/contracts/reasoning');
const { createCostEntry } = require('../../shared/contracts/cost');
const { resolveProviderCapabilities, resolveProviderTraits } = require('../../shared/contracts/provider-capabilities');

/** @typedef {import('../ports/provider-runtime-port').ProviderAdapter} ProviderAdapter */
/** @typedef {import('../ports/provider-runtime-port').ProviderConfig} ProviderConfig */
/** @typedef {import('../../shared/contracts/llm-target').ChatModelTarget} ChatModelTarget */
/** @typedef {import('../../application/ports/llm-port').LlmPort} LlmPort */
/** @typedef {ReturnType<import('../ports/llm-config-store-port').LlmConfigStorePort['resolveChatModelTarget']>} RawChatTarget */

/**
 * `reasoningLevelFor(chatId)` answers with the chat's own reasoning level, or
 * nothing (#725); without `chatId` it asks for the chat on screen.
 * `presetFor(chatId)` names the chat's own model entry when it is not the
 * chat on screen (#1194), or nothing: the active entry applies.
 *
 * @param {Object} deps
 * @param {import('../ports/provider-runtime-port').ProviderRuntimePort} deps.providerRuntime
 * @param {import('../ports/llm-config-store-port').LlmConfigStorePort} deps.llmConfigStore
 * @param {import('../ports/provider-secrets-port').ProviderSecretsPort} deps.providerSecrets
 * @param {(chatId?: string) => Promise<string|null>} [deps.reasoningLevelFor]
 * @param {(chatId?: string) => Promise<string|null>} [deps.presetFor]
 * @param {{ resolve: (model: { providerId: string, model: string, baseUrl?: string }) => Promise<{ price: object|null, priceSource: string|null }>,
 *   tableInfo: () => Promise<{ date: string, origin: string }|null> }|null} [deps.modelPrices]
 * @returns {import('../../application/ports/llm-port').LlmPort}
 */
function createProviderLlmAdapter({
  providerRuntime,
  llmConfigStore,
  providerSecrets,
  reasoningLevelFor = async () => null,
  presetFor = async () => null,
  // Prices for the estimated chat cost (#949); without it no round is priced.
  modelPrices = null,
}) {
  /**
   * @param {RawChatTarget} raw
   * @param {ProviderAdapter|null} provider
   */
  function resolveProviderOptions(raw, provider) {
    if (raw.providerOptions && typeof raw.providerOptions === 'object') {
      return filterDeclaredPresetOptions(raw.providerOptions, provider);
    }
    return filterDeclaredPresetOptions(extractPresetOptions(raw, provider), provider);
  }

  /**
   * The level belongs to the chat (#725): a field of the target, set only
   * when the model takes a level over the entry's connection (#1148).
   * Entries carry none since #726.
   *
   * @param {RawChatTarget} raw
   * @param {string|null} ownLevel
   * @param {Record<string, unknown>} connection  the entry's stored connection
   * @returns {ChatModelTarget}
   */
  function toTarget(raw, ownLevel, connection) {
    const provider = providerRuntime.getProvider(raw.providerId);
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    const providerOptions = resolveProviderOptions(raw, provider);
    const levelModel = model || provider?.defaultModel || '';
    const reasoningEffort = resolveReasoningLevel({
      levels: reasoningLevelsFor(provider, levelModel, connection),
      own: ownLevel,
      defaultLevel: reasoningDefaultFor(provider, levelModel),
    });
    return createChatModelTarget({
      providerId: raw.providerId,
      // Bei `connectionPerPreset` haengt die Verbindung am Eintrag; ohne die
      // Kennung koennte sie hier niemand mehr aufloesen (Issue #202).
      presetId: raw.presetId,
      model,
      providerOptions,
      reasoningEffort,
    });
  }

  /**
   * Verbindungsquelle einer Runde: der Eintrag, sonst der Anbieter.
   * @param {ChatModelTarget} target
   */
  function scopeOf(target) {
    return target?.presetId ? { presetId: target.presetId } : {};
  }

  /**
   * @param {ProviderConfig|null|undefined} baseConfig
   * @param {ChatModelTarget} target
   * @param {ProviderAdapter} provider
   * @returns {ProviderConfig & Record<string, unknown>}
   */
  function mergeProviderConfig(baseConfig, target, provider) {
    /** @type {ProviderConfig & Record<string, unknown>} */
    const merged = { ...(baseConfig || {}) };
    const opts = filterDeclaredPresetOptions(target.providerOptions, provider);
    for (const [key, value] of Object.entries(opts || {})) {
      if (key === 'reasoningEffort') continue;
      merged[key] = value;
    }
    // Only the target's level counts (#725) — never one left in the options.
    delete merged.reasoningEffort;
    if (target.reasoningEffort) merged.reasoningEffort = target.reasoningEffort;
    return merged;
  }

  /**
   * @param {ChatModelTarget} target
   * @param {ProviderAdapter} provider
   * @param {ProviderConfig|null|undefined} baseConfig
   * @returns {string}
   */
  function resolveModel(target, provider, baseConfig) {
    return target.model || baseConfig?.model || provider.defaultModel || '';
  }

  /**
   * @param {ProviderAdapter} provider
   * @param {ProviderConfig} config
   */
  function providerDisplayName(provider, config) {
    const custom = typeof config?.displayName === 'string' ? config.displayName.trim() : '';
    return custom || provider.name;
  }

  /**
   * `chatId`: the chat the round is for; without it, the chat on screen.
   * @type {LlmPort['resolveChatTarget']}
   */
  async function resolveChatTarget({ chatId } = {}) {
    const { config, raw, provider } = await rawTargetOf(chatId);
    if (!provider) {
      return createChatErrorResult({
        error: createMessage('provider.error.unknown', { id: raw.providerId }),
        code: CHAT_ERROR_CODES.INVALID,
      });
    }
    return toTarget(raw, await readOwnLevel(chatId), storedConnectionFor(config, raw, provider));
  }

  /**
   * The levels the chat's model takes over its entry's connection (#1304);
   * empty when it takes none.
   * @type {NonNullable<LlmPort['reasoningLevels']>}
   */
  async function reasoningLevels({ chatId } = {}) {
    const { config, raw, provider } = await rawTargetOf(chatId);
    if (!provider) return [];
    const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : provider.defaultModel || '';
    return reasoningLevelsFor(provider, model, storedConnectionFor(config, raw, provider));
  }

  /** @param {string} [chatId] */
  async function rawTargetOf(chatId) {
    const config = await llmConfigStore.readLLMConfig();
    // A chat off screen keeps its own model rather than the screen's (§7.3).
    const own = await readOwnPreset(chatId);
    const raw = llmConfigStore.resolveChatModelTarget(own ? { ...config, activePresetId: own } : config);
    return { config, raw, provider: providerRuntime.getProvider(raw.providerId) };
  }

  /** @param {string} [chatId] */
  async function readOwnPreset(chatId) {
    if (!chatId) return null;
    try {
      const presetId = await presetFor(chatId);
      return typeof presetId === 'string' && presetId ? presetId : null;
    } catch {
      // A history that cannot be read costs the chat its own entry, not the round: the active one applies.
      return null;
    }
  }

  /** @param {string} [chatId] */
  async function readOwnLevel(chatId) {
    try {
      return (await reasoningLevelFor(chatId)) || null;
    } catch {
      // A history that cannot be read costs the chat its level, not the round.
      return null;
    }
  }

  /** @type {LlmPort['validateTarget']} */
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

  /** @type {LlmPort['prepareSendBundle']} */
  async function prepareSendBundle(target) {
    const provider = providerRuntime.getProvider(target.providerId);
    // `validateTarget` refuses an unknown provider before a round starts.
    if (!provider) throw new Error(`Unknown provider "${target.providerId}".`);
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
      // What the engine may rely on, resolved against this round's
      // connection (#996): the capabilities and the traits.
      capabilities: resolveProviderCapabilities(provider, config),
      traits: resolveProviderTraits(provider, config),
    };
  }

  /**
   * `cacheKey` bindet die Runde an einen Prompt-Cache (Issue #179). Ohne ihn
   * verteilt OpenAI die Anfragen frei auf seine Maschinen, und ein Chat trifft
   * mal auf einen warmen und mal auf einen kalten Cache. Nur OpenAI wertet ihn
   * aus; die uebrigen Provider ignorieren das Feld.
   *
   * @type {import('../../application/ports/llm-port').LlmPort['streamRound']}
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
    // `validateTarget` refuses an unknown provider before a round starts; this
    // is for a caller that skipped it.
    if (!provider) throw new Error(`Unknown provider "${target.providerId}".`);
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
    const result = await provider.streamChatRound({
      config,
      model,
      messages,
      tools,
      callbacks,
      abortSignal,
      cacheKey,
    });
    if (result?.usage) {
      const cost = await priceRound({ providerId: target.providerId, model, config, usage: result.usage });
      if (cost) return { ...result, cost };
    }
    return result;
  }

  /**
   * Prices one round with the model that served it (#949). A failure here
   * must never cost the user the answer, so it only drops the estimate.
   *
   * @param {{ providerId: string, model: string, config: ProviderConfig,
   *   usage: { prompt: number, completion: number, total: number } }} round
   */
  async function priceRound({ providerId, model, config, usage }) {
    try {
      const { price, priceSource } = modelPrices
        ? await modelPrices.resolve({ providerId, model, baseUrl: config?.baseUrl })
        : { price: null, priceSource: null };
      const priceTable = modelPrices ? await modelPrices.tableInfo() : null;
      return { entry: createCostEntry({ providerId, model, usage, price, priceSource }), priceTable };
    } catch {
      return null;
    }
  }

  // Which provider it was is in the bubble already; the sentence names none.
  /** @param {unknown} err */
  function formatRoundError(err) {
    return describeFetchErrorMessage(err);
  }

  return {
    resolveChatTarget,
    reasoningLevels,
    validateTarget,
    prepareSendBundle,
    streamRound,
    formatRoundError,
  };
}

module.exports = {
  createProviderLlmAdapter,
};
