/**
 * LLM-Port: Zielauflösung, Validierung und Streaming ohne Provider-Registry im Core.
 *
 * @typedef {import('../../shared/contracts/llm-target').ChatModelTarget} ChatModelTarget
 * @typedef {import('../../shared/contracts/chat').ChatErrorResult} ChatErrorResult
 */

/**
 * A message of the history as a provider takes it: the chat-completions form,
 * which every adapter translates into its own wire format.
 * @typedef {Object} LlmMessage
 * @property {string} role  `system`, `user`, `assistant` or `tool`
 * @property {unknown} [content]
 * @property {LlmToolCall[]} [tool_calls]  an assistant message's calls
 * @property {string} [tool_call_id]       a tool message's answer to one
 * @property {string} [ollamaThinking]      Ollama's reasoning of an assistant message (#994)
 * @property {{ model: string, blocks: LlmThinkingBlock[] }} [anthropicThinking]  the thinking blocks Anthropic wants back unchanged (#994)
 * @property {unknown} [attachments]       images on a user message (#84)
 * @property {{ sensitive: true, providerKey: string, targets: Array<{ path: string, version: string|null }> }} [sensitiveMarker]
 *   a tool message whose content a `read-sensitive` approval bound to one provider endpoint (§4);
 *   stripped before a request leaves the app
 * @property {boolean} [redacted]           the content was replaced because the endpoint changed
 *
 * One thinking block of an Anthropic round, kept verbatim: the API checks its signature.
 * @typedef {{ type?: string, thinking?: string, signature?: string, data?: string }} LlmThinkingBlock
 *
 * A tool as the model is offered it, in the chat-completions form.
 * @typedef {Object} LlmToolDefinition
 * @property {'function'} [type]
 * @property {{ name?: string, description?: string, parameters?: object }} [function]
 */

/**
 * @typedef {Object} LlmStreamCallbacks
 * @property {() => void} [reset]
 * @property {() => void} onMarkGenerating
 * @property {(text: string) => void} onTextDelta
 * @property {(text: string) => void} [onReasoningDelta]
 * @property {(call: { index?: number|string, name: string, args?: object }) => void} [onToolCallStart]
 *   Das Modell beginnt, einen Tool-Aufruf zu streamen (Name bekannt, Argumente evtl. noch
 *   unvollständig). `args` nur, wenn der Provider den Aufruf bereits komplett liefert.
 * @property {(delta: { index?: number|string, delta: string }) => void} [onToolCallArgumentsDelta]
 *   Weiteres Stück der JSON-Argumente des Tool-Aufrufs mit diesem Provider-Index.
 */

/**
 * One tool call of a finished round, in the form the providers hand over.
 * @typedef {Object} LlmToolCall
 * @property {string} id
 * @property {'function'} type
 * @property {{ name: string, arguments: string }} function  `arguments` is the JSON text
 * @property {string} [thoughtSignature]  Gemini 3: goes back on the same call (#540)
 *
 * @typedef {Object} LlmRoundResult
 * @property {{ role: 'assistant', content: string|null, tool_calls?: LlmToolCall[] }} [message]
 * @property {'stop'|'tool_calls'|'length'|'content_filter'|'incomplete'} [finishReason]
 *   How the round ended, from `shared/contracts/finish-reason.js` (#538). The last three
 *   mean "cut off": the text is partial and the tool calls must not run.
 * @property {{ prompt: number, completion: number, total: number }|null} [usage]
 * @property {{ entry: object, priceTable: { date: string, origin: string }|null }} [cost]
 *   The estimated cost of this round (#949), from `shared/contracts/cost.js`;
 *   absent when the round reported no usage.
 * @property {boolean} [cancelled]
 * @property {string|import('../../shared/contracts/message').Message} [error]
 * @property {string} [code]
 */

/**
 * @typedef {Object} LlmValidateOptions
 * @property {boolean} [forSend]  true → längere NO_API_KEY-Meldung wie bisher bei CHAT_SEND
 */

/**
 * @typedef {Object} LlmSendBundle
 * @property {{ baseUrl?: string } & Object<string, unknown>} config  Per-send snapshot der Provider-Konfiguration
 * @property {string} model
 * @property {string|import('../../shared/contracts/message').Message} [providerName]  display name, for messages to the user
 * @property {{ images?: boolean, imageMediaTypes?: string[], reasoningLevels?: boolean,
 *   gaps?: Object<string, { limitedBy: string, reason: string, issue?: number }> }} [capabilities]
 *   what the provider passes on, resolved for this connection from the
 *   capability register (#996, `shared/contracts/provider-capabilities.js`);
 *   `imageMediaTypes` where it takes fewer than all image formats (#91)
 * @property {{ runsLocally?: boolean, tokenizerProfile?: string, outputLimitSetting?: boolean }} [traits]
 *   facts about the provider the engine steers by instead of its ID (#996):
 *   the history budget, the context estimate, the cut-off sentence
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
 *   messages: LlmMessage[],
 *   tools?: LlmToolDefinition[],
 *   callbacks: LlmStreamCallbacks,
 *   abortSignal: AbortSignal,
 *   sendBundle?: LlmSendBundle,
 *   cacheKey?: string,
 * }) => Promise<LlmRoundResult>} streamRound
 * @property {(err: unknown) => string | import('../../shared/contracts/message').Message} formatRoundError
 */

module.exports = {};
