/**
 * Vertrag, den jeder Provider-Adapter erfüllt (Review 2026-05-23, G10). The
 * types live with the port the adapters are reached through (#1004).
 *
 * @typedef {import('../ports/provider-runtime-port').ProviderAdapter} ProviderAdapter
 */

const { declaredProviderTraits } = require('../../shared/contracts/provider-capabilities');
const openai = require('./openai');
const anthropic = require('./anthropic');
const google = require('./google');
const ollama = require('./ollama');
const openaiCompatible = require('./openai-compatible');

/** @type {Record<string, ProviderAdapter>} */
const PROVIDERS = {
  openai,
  anthropic,
  google,
  ollama,
  'openai-compatible': openaiCompatible,
};
const PROVIDER_ORDER = ['openai', 'anthropic', 'google', 'ollama', 'openai-compatible'];

/**
 * @param {unknown} id
 * @returns {ProviderAdapter|null}
 */
function getProvider(id) {
  // Own keys only: `toString` or `constructor` are no providers (#562).
  return typeof id === 'string' && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
}

/** @returns {import('../ports/provider-runtime-port').ProviderMeta[]} */
function listProviderMeta() {
  return PROVIDER_ORDER.map((id) => {
    const p = PROVIDERS[id];
    return {
      id: p.id,
      name: p.name,
      fields: p.fields || {},
      defaultModel: p.defaultModel || '',
      defaultBaseUrl: p.defaultBaseUrl || '',
      defaultInsecureTls: p.defaultInsecureTls === true,
      apiBase: p.apiBase || '',
      // The adapter's declaration (#996); resolved against an entry where
      // it travels on — settings-presentation-service, provider-llm-adapter.
      capabilities: p.capabilities || {},
      // Ein Anbieter, der ohne Key auskommt (Issue #193): ein leeres Feld ist
      // dort kein unvollstaendiger Zugang.
      optionalApiKey: p.optionalApiKey === true,
      // Verbindung am Eintrag statt am Anbieter (Issue #202).
      connectionPerPreset: p.connectionPerPreset === true,
    };
  });
}

/**
 * The capability register (#996): every provider's declared capabilities and
 * traits, in menu order. The vocabulary is in
 * `shared/contracts/provider-capabilities.js`.
 */
function listCapabilityRegister() {
  return PROVIDER_ORDER.map((id) => ({
    id,
    capabilities: PROVIDERS[id].capabilities || {},
    traits: declaredProviderTraits(PROVIDERS[id]),
  }));
}

/** The LiteLLM providers whose prices the snapshot keeps — those of the register. */
function litellmPriceProviders() {
  return [...new Set(listCapabilityRegister().flatMap((entry) => entry.traits.priceTable.litellmProviders))];
}

/** Gibt Provider-Ressourcen (z. B. undici-Dispatcher) beim App-Ende frei. */
function disposeAll() {
  for (const id of PROVIDER_ORDER) {
    const p = PROVIDERS[id];
    if (typeof p?.dispose !== 'function') continue;
    try {
      p.dispose();
    } catch (err) {
      console.error(`Provider ${id} dispose failed:`, err);
    }
  }
}

module.exports = {
  PROVIDERS,
  PROVIDER_ORDER,
  getProvider,
  listProviderMeta,
  listCapabilityRegister,
  litellmPriceProviders,
  disposeAll,
};
