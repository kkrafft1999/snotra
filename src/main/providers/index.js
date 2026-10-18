/**
 * Vertrag, den jeder Provider-Adapter erfüllt (Review 2026-05-23, G10). The
 * types live with the port the adapters are reached through (#1004).
 *
 * @typedef {import('../ports/provider-runtime-port').ProviderAdapter} ProviderAdapter
 */

const openai = require('./openai');
const anthropic = require('./anthropic');
const google = require('./google');
const ollama = require('./ollama');
const openaiCompatible = require('./openai-compatible');

const PROVIDERS = {
  openai,
  anthropic,
  google,
  ollama,
  'openai-compatible': openaiCompatible,
};
const PROVIDER_ORDER = ['openai', 'anthropic', 'google', 'ollama', 'openai-compatible'];

function getProvider(id) {
  // Own keys only: `toString` or `constructor` are no providers (#562).
  return typeof id === 'string' && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
}

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
      capabilities: { images: p.capabilities?.images === true },
      // Ein Anbieter, der ohne Key auskommt (Issue #193): ein leeres Feld ist
      // dort kein unvollstaendiger Zugang.
      optionalApiKey: p.optionalApiKey === true,
      // Verbindung am Eintrag statt am Anbieter (Issue #202).
      connectionPerPreset: p.connectionPerPreset === true,
    };
  });
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
  disposeAll,
};
