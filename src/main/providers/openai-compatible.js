/**
 * Provider „OpenAI-kompatibel" (Issue #193).
 *
 * Eine Instanz für alles, was eine OpenAI-förmige HTTP-Schnittstelle anbietet
 * und keiner der fünf fest verdrahteten Anbieter ist: LM Studio, llama.cpp,
 * vLLM, firmeninterne Gateways, Router wie OpenRouter. Bewusst **ein**
 * Eintrag — wer das Ziel wechselt, ändert URL und Key.
 *
 * Die beiden Transporte liegen geteilt daneben (`openai-chat-transport.js`,
 * `openai-responses-transport.js`); hier steht nur, was diesen Anbieter
 * ausmacht: Header-Zusammenbau, TLS-Ausnahme, API-Stil und die Frage, ob der
 * Endpunkt lokal oder entfernt steht.
 */
'use strict';

const { Agent } = require('undici');
const {
  withRequestTimeout,
  userMessageOf,
  CLOUD_MODELS_TIMEOUT_MS,
  LOCAL_MODELS_TIMEOUT_MS,
} = require('../services/request-timeout');
const { isLocalEndpoint } = require('../../shared/contracts/provider-endpoint');
const { listChatModels, streamChatCompletionsRound } = require('./openai-chat-transport');
const { streamResponsesRound } = require('./openai-responses-transport');

const DEFAULT_BASE = 'http://localhost:1234/v1';
const API_STYLE_CHAT = 'chat';
const API_STYLE_FULL = 'full';

/**
 * Vorlagen belegen nur Werte vor; gespeichert wird die Auswahl nicht. Nach dem
 * Klick ist jedes Feld wieder frei — die Vorlage ist eine Abkürzung, keine
 * Betriebsart.
 */
const TEMPLATES = Object.freeze([
  {
    id: 'lm-studio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    apiStyle: API_STYLE_CHAT,
    hint: 'Lokaler Server von LM Studio, ohne API-Key.',
  },
  {
    id: 'mlx-lm',
    label: 'MLX-LM',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiStyle: API_STYLE_CHAT,
    hint: 'mlx_lm.server auf Apple Silicon, ohne API-Key.',
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp',
    baseUrl: 'http://localhost:8080/v1',
    apiStyle: API_STYLE_CHAT,
    hint: 'llama-server mit eingebautem OpenAI-Layer.',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    apiStyle: API_STYLE_CHAT,
    hint: 'vLLM-OpenAI-Server; ein API-Key ist dort optional.',
  },
  {
    id: 'ollama',
    label: 'Ollama (/v1)',
    baseUrl: 'http://localhost:11434/v1',
    apiStyle: API_STYLE_CHAT,
    hint: 'Notausgang für entfernte Ollama-Instanzen hinter einem Gateway — lokal ist der eigene Anbieter „Ollama" der bessere Weg.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiStyle: API_STYLE_CHAT,
    hint: 'Router-Dienst mit Bearer-Key und sehr langer Modellliste.',
  },
  {
    id: 'custom',
    label: 'Eigener Endpunkt',
    baseUrl: '',
    apiStyle: API_STYLE_CHAT,
    hint: 'URL, Key und Header selbst eintragen.',
  },
]);

// --- TLS-Ausnahme ----------------------------------------------------------
// Wie bei Ollama: ein lazy gebauter undici-Agent ohne Zertifikatsprüfung, der
// nur greift, wenn der Nutzer es ausdrücklich eingeschaltet hat UND die
// Ziel-URL https ist.
let _insecureDispatcher = null;
const _warnedInsecureUrls = new Set();

function getInsecureDispatcher() {
  if (!_insecureDispatcher) {
    _insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return _insecureDispatcher;
}

function dispatcherFor(url, config) {
  if (!config?.insecureTls) return undefined;
  if (!url.startsWith('https://')) return undefined;
  if (!_warnedInsecureUrls.has(url)) {
    _warnedInsecureUrls.add(url);
    // Nur die URL — Zusatz-Header sind ein Geheimnis und gehören in kein Log.
    console.warn(`[openai-compatible] TLS-Zertifikatsprüfung deaktiviert für ${url}`);
  }
  return getInsecureDispatcher();
}

// --- Konfiguration ---------------------------------------------------------

function baseUrlOf(config) {
  const raw = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  return (raw || DEFAULT_BASE).replace(/\/$/, '');
}

function apiStyleOf(config) {
  return config?.apiStyle === API_STYLE_FULL ? API_STYLE_FULL : API_STYLE_CHAT;
}

function sendToolsOf(config) {
  return config?.sendTools !== false;
}

function supportsImagesOf(config) {
  return config?.supportsImages === true;
}

/** Zeitlimit der Modellliste: am Host, nicht an der Provider-ID (Issue #193). */
function modelsTimeoutFor(config) {
  return isLocalEndpoint(baseUrlOf(config)) ? LOCAL_MODELS_TIMEOUT_MS : CLOUD_MODELS_TIMEOUT_MS;
}

/**
 * Header, die der Nutzer nicht setzen darf, weil sie den Transport selbst
 * beschreiben: fetch berechnet sie, ein eigener Wert macht die Anfrage kaputt
 * statt sie anzupassen.
 */
const PROTECTED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Steuerzeichen als Escape-Sequenzen, nicht als Zeichen: Ein echtes NUL-Byte
// im Quelltext macht die Datei fuer Git zur Binaerdatei, und ein Diff zeigt
// dann nur noch „Bin 0 -> N bytes".
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * „Name: Wert" je Zeile → Header-Objekt. Ungültige Zeilen werden still
 * übergangen: Ein Fehlertext mit dem Inhalt der Zeile wäre eine Kopie des
 * Geheimnisses an einer Stelle, an der es nicht hingehört.
 */
function parseExtraHeaders(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) continue;
    const name = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (!HEADER_NAME_PATTERN.test(name)) continue;
    if (PROTECTED_HEADERS.has(name.toLowerCase())) continue;
    // Steuerzeichen würden die Anfrage aufspalten (Header-Injection).
    if (CONTROL_CHARS_PATTERN.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Header einer Anfrage. Ohne Key bleibt `Authorization` **weg** — das ist der
 * Normalfall bei lokalen Servern, kein Fehler. Zusatz-Header stehen zuletzt und
 * dürfen `Authorization` bewusst überschreiben: manche Gateways verlangen ein
 * anderes Schema als Bearer.
 */
function buildHeaders(config, { json = true } = {}) {
  const headers = json ? { 'Content-Type': 'application/json' } : {};
  const apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : '';
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { ...headers, ...parseExtraHeaders(config?.extraHeaders) };
}

// --- Modellliste -----------------------------------------------------------

async function listModels(config) {
  try {
    return await withRequestTimeout((signal) => listModelsRequest({ ...config, signal }), {
      signal: config?.signal,
      timeoutMs: config?.timeoutMs ?? modelsTimeoutFor(config),
    });
  } catch (err) {
    return { error: userMessageOf(err) };
  }
}

async function listModelsRequest(config) {
  const base = baseUrlOf(config);
  return listChatModels({
    baseUrl: base,
    headers: buildHeaders(config, { json: false }),
    signal: config.signal,
    dispatcher: dispatcherFor(`${base}/models`, config),
  });
}

// --- Chat ------------------------------------------------------------------

/**
 * Base-URLs, bei denen `/responses` in dieser Sitzung mit 404/405 geantwortet
 * hat. Der Rückfall gilt nur für die Laufzeit; gespeichert bleibt die Wahl im
 * Dropdown, damit ein kurzzeitig falsch antwortendes Gateway die Einstellung
 * nicht dauerhaft umschreibt.
 */
const _chatFallbackBases = new Set();

/** Nur diese beiden Status heißen „diesen Pfad gibt es hier nicht". */
function meansNoResponsesApi(status) {
  return status === 404 || status === 405;
}

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal }) {
  const base = baseUrlOf(config);
  const shared = {
    baseUrl: base,
    headers: buildHeaders(config),
    model,
    messages,
    tools,
    callbacks,
    abortSignal,
    supportsImages: supportsImagesOf(config),
    sendTools: sendToolsOf(config),
  };

  const wantsResponses = apiStyleOf(config) === API_STYLE_FULL && !_chatFallbackBases.has(base);
  if (wantsResponses) {
    const result = await streamResponsesRound({
      ...shared,
      dispatcher: dispatcherFor(`${base}/responses`, config),
      includeStatus: true,
    });
    if (!meansNoResponsesApi(result?.status)) {
      // `status` ist nur die interne Weiche und gehört nicht ins Ergebnis.
      if (result && 'status' in result) delete result.status;
      return result;
    }
    _chatFallbackBases.add(base);
  }

  return streamChatCompletionsRound({
    ...shared,
    dispatcher: dispatcherFor(`${base}/chat/completions`, config),
    callIdPrefix: 'compat_call_',
  });
}

function dispose() {
  if (_insecureDispatcher) {
    _insecureDispatcher.close?.();
    _insecureDispatcher.destroy?.();
    _insecureDispatcher = null;
  }
  _warnedInsecureUrls.clear();
  _chatFallbackBases.clear();
}

module.exports = {
  id: 'openai-compatible',
  name: 'OpenAI-kompatibel',
  fields: {
    apiKey: true,
    baseUrl: true,
    insecureTls: true,
    displayName: true,
    apiStyle: true,
    extraHeaders: true,
    supportsImages: true,
    sendTools: true,
  },
  // Der API-Key ist hier **optional**: ein lokaler Server ohne Key ist ein
  // gültiger, vollständig konfigurierter Zustand.
  optionalApiKey: true,
  // Die Verbindung gehört zum **Eintrag**, nicht zum Anbieter (Issue #202).
  // Nur so stehen ein lokaler Server und ein Gateway nebeneinander; bei den
  // übrigen fünf Anbietern bleibt sie am Anbieter, damit sich etwa der
  // OpenAI-Schlüssel nicht über mehrere Zeilen verteilt.
  connectionPerPreset: true,
  // Voreinstellung; die tatsächliche Fähigkeit steht in der Konfiguration und
  // kommt aus `capabilitiesFor`.
  capabilities: { images: false },
  capabilitiesFor(config) {
    return { images: supportsImagesOf(config) };
  },
  defaultModel: '',
  defaultBaseUrl: DEFAULT_BASE,
  defaultInsecureTls: false,
  defaultApiStyle: API_STYLE_CHAT,
  defaultSendTools: true,
  defaultSupportsImages: false,
  apiBase: DEFAULT_BASE,
  presentation: {
    apiKeyPlaceholder: 'leer lassen, wenn der Server keinen Key verlangt',
    baseUrlPlaceholder: DEFAULT_BASE,
    connectionDetail: true,
    manualModel: true,
    templates: TEMPLATES,
    apiStyleOptions: [
      { value: API_STYLE_CHAT, label: 'Nur Chat Completions' },
      { value: API_STYLE_FULL, label: 'Responses, sonst Chat Completions' },
    ],
  },
  // Fuer Tests und die Wiederverwendung an anderer Stelle.
  API_STYLE_CHAT,
  API_STYLE_FULL,
  TEMPLATES,
  parseExtraHeaders,
  buildHeaders,
  listModels,
  streamChatRound,
  dispose,
};
