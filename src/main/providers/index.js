/**
 * Vertrag, den jeder Provider-Adapter erfüllt (Review 2026-05-23, G10).
 *
 * @typedef {Object} ProviderConfig
 * @property {string} [apiKey]        Entschlüsselter API-Key (falls fields.apiKey).
 * @property {string} [baseUrl]       Server-URL (falls fields.baseUrl).
 * @property {boolean} [insecureTls]  TLS-Prüfung deaktivieren (falls fields.insecureTls).
 * @property {string} [model]         Zuletzt gespeichertes Modell.
 * @property {string} [reasoningEffort] Nur OpenAI: minimal|low|medium|high.
 *
 * @typedef {Object} StreamCallbacks
 * @property {() => void} [onMarkGenerating]        Erster sichtbarer Output dieser Runde.
 * @property {(text: string) => void} [onTextDelta]      Antwort-Textdelta.
 * @property {(text: string) => void} [onReasoningDelta] Reasoning-/Thinking-Delta.
 *
 * @typedef {Object} AssistantMessage
 * @property {'assistant'} role
 * @property {string} content
 * @property {Array<{id: string, type: 'function', function: {name: string, arguments: string}}>} [tool_calls]
 *
 * @typedef {Object} ChatRoundResult
 * @property {AssistantMessage} [message]   Bei Erfolg die Assistant-Nachricht der Runde.
 * @property {'stop'|'tool_calls'|string} [finishReason]
 * @property {{prompt: number, completion: number, total: number}|null} [usage]
 * @property {boolean} [cancelled]          true, wenn per AbortSignal abgebrochen.
 * @property {string} [error]               Fehlertext (schließt message aus).
 * @property {string} [code]                Fehlercode, z. B. NO_API_KEY, NETWORK, HTTP-Status.
 *
 * @typedef {Object} ProviderAdapter
 * @property {string} id
 * @property {string} name
 * @property {{apiKey?: boolean, baseUrl?: boolean, insecureTls?: boolean, displayName?: boolean,
 *   apiStyle?: boolean, extraHeaders?: boolean, supportsImages?: boolean, sendTools?: boolean}} [fields]
 *   Welche Konfig-Felder der Provider braucht.
 * @property {boolean} [optionalApiKey] Der Key darf leer bleiben (Issue #193).
 * @property {boolean} [connectionPerPreset] Verbindung gehoert zum Eintrag (Issue #202).
 * @property {(config: ProviderConfig) => {images: boolean}} [capabilitiesFor]
 *   Faehigkeiten, die erst aus der Konfiguration folgen statt fest am Adapter zu haengen.
 * @property {string} [defaultModel]
 * @property {string} [defaultBaseUrl]
 * @property {boolean} [defaultInsecureTls]
 * @property {string} [apiBase]            Anzeige-URL der API (Settings-UI).
 * @property {(config: ProviderConfig) => Promise<{models?: Array<{id: string, label?: string}>, error?: string}>} listModels
 * @property {(params: {config: ProviderConfig, model: string, messages: Array<Object>, tools?: Array<Object>, callbacks?: StreamCallbacks, abortSignal?: AbortSignal}) => Promise<ChatRoundResult>} streamChatRound
 * @property {() => void} [dispose]        Ressourcen freigeben (App-Ende).
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
  return PROVIDERS[id] || null;
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
