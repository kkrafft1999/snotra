/**
 * LLM-Port: Zielauflösung, Validierung und Streaming ohne Provider-Registry im Core.
 *
 * @typedef {import('../../shared/contracts/llm-target').ChatModelTarget} ChatModelTarget
 * @typedef {import('../../shared/contracts').ChatErrorResult} ChatErrorResult
 */

/**
 * @typedef {Object} LlmStreamCallbacks
 * @property {() => void} [reset]
 * @property {() => void} [onMarkGenerating]
 * @property {(text: string) => void} [onTextDelta]
 * @property {(text: string) => void} [onReasoningDelta]
 * @property {(call: { index?: number|string, name: string, args?: object }) => void} [onToolCallStart]
 *   Das Modell beginnt, einen Tool-Aufruf zu streamen (Name bekannt, Argumente evtl. noch
 *   unvollständig). `args` nur, wenn der Provider den Aufruf bereits komplett liefert.
 * @property {(delta: { index?: number|string, delta: string }) => void} [onToolCallArgumentsDelta]
 *   Weiteres Stück der JSON-Argumente des Tool-Aufrufs mit diesem Provider-Index.
 */

/**
 * @typedef {Object} LlmRoundResult
 * @property {{ role: 'assistant', content: string|null, tool_calls?: Array }} [message]
 * @property {'stop'|'tool_calls'|'length'|'content_filter'|'incomplete'} [finishReason]
 *   How the round ended, from `shared/contracts/finish-reason.js` (#538). The last three
 *   mean "cut off": the text is partial and the tool calls must not run.
 * @property {{ prompt: number, completion: number, total: number }|null} [usage]
 * @property {boolean} [cancelled]
 * @property {string} [error]
 * @property {string} [code]
 */

/**
 * @typedef {Object} LlmValidateOptions
 * @property {boolean} [forSend]  true → längere NO_API_KEY-Meldung wie bisher bei CHAT_SEND
 */

/**
 * @typedef {Object} LlmSendBundle
 * @property {object} config  Per-send snapshot der Provider-Konfiguration
 * @property {string} model
 * @property {string} [providerName]  display name, for messages to the user
 * @property {{ images?: boolean }} [capabilities]  what the provider passes on (#93)
 */

/**
 * @typedef {Object} LlmPort
 * @property {(params?: { chatId?: string }) => Promise<ChatModelTarget|ChatErrorResult>} resolveChatTarget
 *   With `chatId`, the target carries that chat's reasoning level (#725);
 *   without, the level of the chat on screen.
 * @property {(target: ChatModelTarget, options?: LlmValidateOptions) => Promise<ChatErrorResult|null>} validateTarget
 * @property {(target: ChatModelTarget) => Promise<LlmSendBundle>} prepareSendBundle
 * @property {(params: {
 *   target: ChatModelTarget,
 *   messages: Array,
 *   tools?: Array,
 *   callbacks: LlmStreamCallbacks,
 *   abortSignal: AbortSignal,
 *   sendBundle?: LlmSendBundle,
 *   cacheKey?: string,
 * }) => Promise<LlmRoundResult>} streamRound
 * @property {(err: unknown) => string} formatRoundError
 */

module.exports = {};
