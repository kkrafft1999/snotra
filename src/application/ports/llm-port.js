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
 */

/**
 * @typedef {Object} LlmRoundResult
 * @property {{ role: 'assistant', content: string|null, tool_calls?: Array }} [message]
 * @property {string} [finishReason]
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
 */

/**
 * @typedef {Object} LlmPort
 * @property {() => Promise<ChatModelTarget|ChatErrorResult>} resolveChatTarget
 * @property {(target: ChatModelTarget, options?: LlmValidateOptions) => Promise<ChatErrorResult|null>} validateTarget
 * @property {(target: ChatModelTarget) => Promise<LlmSendBundle>} prepareSendBundle
 * @property {(params: {
 *   target: ChatModelTarget,
 *   messages: Array,
 *   tools?: Array,
 *   callbacks: LlmStreamCallbacks,
 *   abortSignal: AbortSignal,
 *   sendBundle?: LlmSendBundle,
 * }) => Promise<LlmRoundResult>} streamRound
 * @property {(err: unknown) => string} formatRoundError
 */

module.exports = {};
