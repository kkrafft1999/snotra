/**
 * Provider-Laufzeit: volle Adapter-Module für listModels/streamChatRound.
 *
 * @typedef {Object} ProviderRuntimePort
 * @property {(id: string) => ProviderAdapter|null} getProvider
 * @property {() => ProviderMeta[]} listProviderMeta  every provider's catalogue entry, in menu order
 * @property {() => void} disposeAll
 */

/**
 * The contract every provider module under `main/providers/` fulfils (review
 * 2026-05-23, G10; moved here from `providers/index.js` in #1004).
 *
 * @typedef {import('../../shared/contracts/message').Message} Message
 * @typedef {import('../../application/ports/llm-port').LlmMessage} LlmMessage
 * @typedef {import('../../application/ports/llm-port').LlmToolDefinition} LlmToolDefinition
 *
 * A text a provider definition gives the settings: plain, or a message the
 * interface resolves in its own language.
 * @typedef {string|Message} ProviderText
 *
 * One option of a preset field or of the API style.
 * @typedef {Object} ProviderOption
 * @property {string} value
 * @property {ProviderText} [label]
 *
 * A field the add-model dialog shows for the provider's presets (#414); the
 * settings contract builds its view from this (`buildPresetFieldViews`).
 * @typedef {Object} ProviderPresetField
 * @property {string} key
 * @property {'select'} type  `PRESET_FIELD_TYPES`
 * @property {'dropdown'|'segmented'|'switch'} [control]  `PRESET_FIELD_CONTROLS`; a switch has two options, the first is off
 * @property {ProviderText} [label]
 * @property {ProviderText} [toggleLabel]  the switch's label next to it
 * @property {ProviderText} [hint]
 * @property {string} [defaultValue]  the first option when absent
 * @property {boolean} [affectsPresetIdentity]  a different value is a different entry
 * @property {string} [detailPrefix]
 * @property {'default'|'mono'} [detailStyle]  `PRESET_DETAIL_STYLES`
 * @property {ProviderOption[]} options
 * @property {(value: string) => string} [formatDetail]  the text of the entry's detail line, empty for none
 *
 * A starting point for the "OpenAI-compatible" provider (#193).
 * @typedef {Object} ProviderTemplate
 * @property {string} id
 * @property {ProviderText} [label]
 * @property {string} [baseUrl]
 * @property {'chat'|'full'} [apiStyle]
 * @property {ProviderText} [hint]
 *
 * @typedef {Object} ProviderPresentation
 * @property {ProviderText} [apiKeyPlaceholder]
 * @property {string} [baseUrlPlaceholder]
 * @property {ProviderText} [insecureTlsHint]
 * @property {boolean} [connectionDetail]  the settings show the connection as a detail line (#202)
 * @property {boolean} [manualModel]  the model can be typed in where no list is reachable
 * @property {string} [offeredModels]  pattern (source of a case-insensitive RegExp) of the models still offered (#724)
 * @property {ProviderText} [offeredModelsHint]  what the dialog says about a model that does not match
 * @property {ProviderOption[]} [apiStyleOptions]
 * @property {ProviderTemplate[]} [templates]
 * @property {ProviderPresetField[]} [presetFields]
 *
 * @typedef {Object} ProviderConfig
 * @property {string} [apiKey]        Entschlüsselter API-Key (falls fields.apiKey).
 * @property {string} [baseUrl]       Server-URL (falls fields.baseUrl).
 * @property {boolean} [insecureTls]  TLS-Prüfung deaktivieren (falls fields.insecureTls).
 * @property {string} [model]         Zuletzt gespeichertes Modell.
 * @property {string} [displayName]
 * @property {string} [apiStyle]      `chat` or `full` (OpenAI-compatible).
 * @property {string} [extraHeaders]  Decrypted, one `Name: value` per line.
 * @property {boolean} [supportsImages]
 * @property {boolean} [sendTools]
 * @property {number} [maxOutputTokens]
 * @property {string} [reasoningEffort] The chat's reasoning level, one of the
 *   levels `provider.reasoning` names for the model (#725, #994).
 * @property {string} [reasoningSummary]  OpenAI: `auto` streams a summary of the reasoning (#87), a preset option.
 * @property {AbortSignal} [signal]       Model listing only: cancels the request.
 * @property {number} [timeoutMs]         Model listing only: overrides the default timeout.
 *
 * @typedef {Object} StreamCallbacks
 * @property {() => void} onMarkGenerating        Erster sichtbarer Output dieser Runde.
 * @property {(text: string) => void} onTextDelta      Antwort-Textdelta.
 * @property {(text: string) => void} [onReasoningDelta] Reasoning-/Thinking-Delta.
 * @property {(call: { index?: number|string, name: string, args?: object }) => void} [onToolCallStart]
 *   The model starts streaming a tool call; `args` only where the provider hands the call over whole.
 * @property {(delta: { index?: number|string, delta: string }) => void} [onToolCallArgumentsDelta]
 *   Another piece of that call's JSON arguments.
 *
 * @typedef {Object} AssistantMessage
 * @property {'assistant'} role
 * @property {string|null} content         `null` for a round that holds tool calls only
 * @property {string} [ollamaThinking]      Ollama: what the model thought, read back within a tool loop (#994)
 * @property {{ model: string, blocks: import('../../application/ports/llm-port').LlmThinkingBlock[] }} [anthropicThinking]  Anthropic: the thinking blocks of the round (#994)
 * @property {import('../../application/ports/llm-port').LlmToolCall[]} [tool_calls]
 *
 * @typedef {Object} ChatRoundResult
 * @property {AssistantMessage} [message]   Bei Erfolg die Assistant-Nachricht der Runde.
 * @property {'stop'|'tool_calls'|'length'|'content_filter'|'incomplete'} [finishReason]
 *   Mapped onto `shared/contracts/finish-reason.js` (#538), never the provider's raw value.
 * @property {string} [param]              The request field the API objects to (`error.param`), when it names one (#718).
 * @property {import('../../shared/contracts/usage').Usage|null} [usage]
 * @property {boolean} [cancelled]          true, wenn per AbortSignal abgebrochen.
 * @property {string|Message} [error]      Fehlertext (schließt message aus); a message where Snotra says it itself (#308).
 * @property {number} [status]              The HTTP status of a refused request, with `includeStatus` (#193).
 * @property {string} [code]                Fehlercode, z. B. NO_API_KEY, NETWORK, HTTP-Status.
 *
 * @typedef {Object} ProviderCapabilityDeclaration
 * @property {true|false|'per-connection'} supported
 * @property {string} [setting]   per-connection: the boolean connection setting it follows
 * @property {string} [reason]    a gap: the message key the UI can show
 * @property {number} [issue]     a gap for good (`false`): the issue that tracks it
 * @property {readonly string[]} [mediaTypes]  images: the formats, where fewer than all (#91)
 *
 * Which connection fields a provider needs.
 * @typedef {{apiKey?: boolean, baseUrl?: boolean, insecureTls?: boolean, displayName?: boolean,
 *   apiStyle?: boolean, extraHeaders?: boolean, supportsImages?: boolean, sendTools?: boolean, maxOutputTokens?: boolean}} ProviderFields
 *
 * What `listProviderMeta` lists for each provider: the plain facts, without the
 * functions of the adapter.
 * @typedef {Object} ProviderMeta
 * @property {string} id
 * @property {ProviderText} name
 * @property {ProviderFields} fields
 * @property {string} defaultModel
 * @property {string} defaultBaseUrl
 * @property {boolean} defaultInsecureTls
 * @property {string} apiBase
 * @property {Object<string, ProviderCapabilityDeclaration>} capabilities
 * @property {boolean} optionalApiKey
 * @property {boolean} connectionPerPreset
 *
 * @typedef {Object} ProviderAdapter
 * @property {string} id
 * @property {ProviderText} name
 * @property {ProviderFields} [fields]
 *   Welche Konfig-Felder der Provider braucht.
 * @property {boolean} [optionalApiKey] Der Key darf leer bleiben (Issue #193).
 * @property {boolean} [connectionPerPreset] Verbindung gehoert zum Eintrag (Issue #202).
 * @property {string} [defaultModel]
 * @property {string} [defaultBaseUrl]
 * @property {boolean} [defaultInsecureTls]
 * @property {'chat'|'full'} [defaultApiStyle]  (OpenAI-compatible, #193)
 * @property {boolean} [defaultSupportsImages]
 * @property {boolean} [defaultSendTools]
 * @property {string} [apiBase]            Anzeige-URL der API (Settings-UI).
 * @property {Object<string, ProviderCapabilityDeclaration>} capabilities  the provider's entry in
 *   the capability register (#996): every capability of PROVIDER_CAPABILITIES
 *   (`shared/contracts/provider-capabilities.js`), each gap with a reason key
 *   and an issue
 * @property {{ runsLocally?: boolean, tokenizerProfile?: string,
 *   priceTable?: { litellmProviders?: string[], keyPrefixes?: string[] } }} [traits]
 *   facts that steer behaviour without being a feature (#996)
 * @property {import('../../shared/contracts/reasoning').ReasoningDeclaration} [reasoning]
 *   the reasoning levels a chat can choose (#725); per model where the
 *   provider's models differ (#994)
 * @property {ProviderPresentation} [presentation]  how the settings show the provider: placeholders, offered models, entry fields
 * @property {(config: ProviderConfig) => Promise<{models?: Array<{id: string, label?: string}>, error?: string|Message}>} listModels
 * @property {(params: {config: ProviderConfig, model: string, messages: LlmMessage[], tools?: LlmToolDefinition[], callbacks: StreamCallbacks, abortSignal?: AbortSignal, cacheKey?: string}) => Promise<ChatRoundResult>} streamChatRound
 * @property {() => void} [dispose]        Ressourcen freigeben (App-Ende).
 */

module.exports = {};
