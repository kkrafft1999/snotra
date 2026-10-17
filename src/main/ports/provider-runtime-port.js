/**
 * Provider-Laufzeit: volle Adapter-Module für listModels/streamChatRound.
 *
 * @typedef {Object} ProviderRuntimePort
 * @property {(id: string) => ProviderAdapter|null} getProvider
 * @property {() => Array<object>} listProviderMeta  every provider's catalogue entry, in menu order
 * @property {() => void} disposeAll
 */

/**
 * The contract every provider module under `main/providers/` fulfils (review
 * 2026-05-23, G10; moved here from `providers/index.js` in #1004).
 *
 * @typedef {import('../../shared/contracts/message').Message} Message
 *
 * @typedef {Object} ProviderConfig
 * @property {string} [apiKey]        Entschlüsselter API-Key (falls fields.apiKey).
 * @property {string} [baseUrl]       Server-URL (falls fields.baseUrl).
 * @property {boolean} [insecureTls]  TLS-Prüfung deaktivieren (falls fields.insecureTls).
 * @property {string} [model]         Zuletzt gespeichertes Modell.
 * @property {string} [reasoningEffort] Nur OpenAI: none|minimal|low|medium|high|xhigh|max.
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
 * @property {'stop'|'tool_calls'|'length'|'content_filter'|'incomplete'} [finishReason]
 *   Mapped onto `shared/contracts/finish-reason.js` (#538), never the provider's raw value.
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
 * @property {{ images: boolean }} [capabilities]  what the provider passes on, when it does not depend on the configuration (#93)
 * @property {{ levels: string[], defaultLevel?: string, appliesTo?: (model: string) => boolean }} [reasoning]
 *   the reasoning levels a chat can choose (#725)
 * @property {Object} [presentation]  how the settings show the provider: placeholders, offered models, entry fields
 * @property {(config: ProviderConfig) => Promise<{models?: Array<{id: string, label?: string}>, error?: string|Message}>} listModels
 * @property {(params: {config: ProviderConfig, model: string, messages: Array<Object>, tools?: Array<Object>, callbacks?: StreamCallbacks, abortSignal?: AbortSignal, cacheKey?: string}) => Promise<ChatRoundResult>} streamChatRound
 * @property {() => void} [dispose]        Ressourcen freigeben (App-Ende).
 */

module.exports = {};
