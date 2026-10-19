/**
 * Transport für die **Chat-Completions**-API (`POST {base}/chat/completions`).
 *
 * Grundlage von `openai-compatible.js` (Issue #193).
 * Der Baustein kennt weder Anbieter-IDs noch gespeicherte Konfiguration: Er
 * bekommt fertige Header, eine Base-URL und die Nachrichten und liefert ein
 * `ChatRoundResult` zurück. Alles Anbieter-Eigene (welche Header, ob Bilder,
 * ob Tools) entscheidet der Aufrufer.
 */
'use strict';

/** @typedef {import('../../application/ports/llm-port').LlmMessage} LlmMessage */
/** @typedef {import('../../application/ports/llm-port').LlmToolDefinition} LlmToolDefinition */
/** @typedef {import('../ports/provider-runtime-port').StreamCallbacks} StreamCallbacks */
/** @typedef {import('../ports/provider-runtime-port').ChatRoundResult} ChatRoundResult */
/** @typedef {import('../ports/provider-runtime-port').AssistantMessage} AssistantMessage */
/** @typedef {NonNullable<AssistantMessage['tool_calls']>[number]} ToolCall */

/**
 * A tool call as the server streams it, piece by piece.
 * @typedef {Object} ToolCallDelta
 * @property {unknown} [index]
 * @property {string} [id]
 * @property {string} [type]
 * @property {{ name?: string, arguments?: unknown }} [function]
 *
 * What of a streamed Chat Completions event is read.
 * @typedef {Object} ChatCompletionChunk
 * @property {unknown} [error]  `{ message, code }`, or a bare string on some servers
 * @property {unknown} [usage]
 * @property {Array<{
 *   delta?: { content?: unknown, refusal?: unknown, reasoning_content?: unknown, reasoning?: unknown, tool_calls?: ToolCallDelta[] },
 *   finish_reason?: string|null,
 * }>} [choices]
 *
 * @typedef {Object} ChatCompletionsRoundOptions
 * @property {string} baseUrl
 * @property {Record<string, string>} headers
 * @property {string} model
 * @property {LlmMessage[]} messages
 * @property {LlmToolDefinition[]} [tools]
 * @property {StreamCallbacks} callbacks
 * @property {AbortSignal} [abortSignal]
 * @property {import('undici').Dispatcher} [dispatcher]  for a connection with its own TLS settings
 * @property {boolean} [supportsImages]
 * @property {boolean} [sendTools]
 * @property {string} [callIdPrefix]  for a server that sends no call ids
 * @property {number} [maxOutputTokens]
 * @property {Record<string, unknown>} [extraBody]
 */

const { imageAttachmentsOf, toDataUrl } = require('../../shared/contracts/attachments');
const { createMessage } = require('../../shared/contracts/message');
const { FINISH_REASONS, finishReasonOf } = require('../../shared/contracts/finish-reason');
const { isMaxOutputTokens } = require('../../shared/contracts/settings');
const { fetchVia } = require('../services/dispatcher-fetch');
const { isRecord } = require('../../shared/runtime/is-record');
const {
  iterSseEvents,
  describeFetchErrorMessage,
  readErrorMessage,
  abortIfRequested,
  cancelledChatRound,
  isAbortError,
  bindAbortSignalToReader,
  normalizeUsage,
  notifyToolCallStart,
  notifyToolCallArgumentsDelta,
} = require('./stream-helpers');

/**
 * Verlauf (Chat-Completions-Form) → Request-Nachrichten.
 *
 * `supportsImages` entscheidet, ob Bild-Anhänge als `image_url`-Teile
 * mitgehen. Ohne das Flag bleibt es beim reinen Text — ein Server, der die
 * getypte Content-Form nicht kennt, antwortet sonst mit 400 statt zu ignorieren.
 *
 * @param {LlmMessage[]} messages
 * @param {{ supportsImages?: boolean }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
function translateMessagesToChatCompletions(messages, { supportsImages = false } = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      const textContent = typeof m.content === 'string' ? m.content : '';
      const images = supportsImages && m.role === 'user' ? imageAttachmentsOf(m) : [];
      if (images.length === 0) {
        out.push({ role: m.role, content: textContent });
        continue;
      }
      // Mit Bild verlangt die API getypte Teile statt eines Strings; ein leerer
      // Text-Teil entfaellt, denn ein Screenshot ohne Begleitfrage ist eine
      // gueltige Eingabe (Issue #84).
      /** @type {Array<Record<string, unknown>>} */
      const content = [];
      if (textContent) content.push({ type: 'text', text: textContent });
      for (const image of images) {
        content.push({ type: 'image_url', image_url: { url: toDataUrl(image) } });
      }
      out.push({ role: m.role, content });
      continue;
    }
    if (m.role === 'assistant') {
      /** @type {Record<string, unknown>} */
      const row = {
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content : null,
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        row.tool_calls = m.tool_calls;
      }
      out.push(row);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.tool_call_id || '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
    }
  }
  return out;
}

/**
 * @param {LlmToolDefinition[]|undefined} tools
 * @returns {Array<Record<string, unknown>>|undefined}
 */
function translateToolsToChatCompletions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const t of tools) {
    const fn = t?.function;
    if (!fn?.name) continue;
    out.push({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

// Tool calls by the index the server gives them. A Map, not an array: the
// index comes from the stream, and `toolCalls[2e9] = …` would make a sparse
// array that every later walk crawls through for half a minute (#539).
/**
 * @param {Map<number, ToolCall>} toolCalls
 * @param {ToolCallDelta} deltaToolCall
 * @param {string} callIdPrefix
 */
function applyToolCallDelta(toolCalls, deltaToolCall, callIdPrefix) {
  const index = typeof deltaToolCall?.index === 'number' && Number.isInteger(deltaToolCall.index)
    ? deltaToolCall.index
    : toolCalls.size;
  let target = toolCalls.get(index);
  if (!target) {
    target = {
      id: deltaToolCall?.id || `${callIdPrefix}${index}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: '', arguments: '' },
    };
    toolCalls.set(index, target);
  }
  if (deltaToolCall.id) target.id = deltaToolCall.id;
  if (deltaToolCall.type === 'function') target.type = deltaToolCall.type;
  if (deltaToolCall.function?.name) target.function.name += deltaToolCall.function.name;
  const argumentsDelta =
    typeof deltaToolCall.function?.arguments === 'string' ? deltaToolCall.function.arguments : '';
  if (argumentsDelta) target.function.arguments += argumentsDelta;
  return { index, target, argumentsDelta };
}

// Der Name kann in Stücken kommen; erst wenn Argumente eintreffen, ist er komplett.
// Deshalb wird der Aufruf beim ersten Argument-Stück gemeldet, nicht beim Namen.
/**
 * @param {StreamCallbacks} callbacks
 * @param {Set<number>} announced
 * @param {ReturnType<typeof applyToolCallDelta>} update
 */
function announceToolCallDelta(callbacks, announced, { index, target, argumentsDelta }) {
  if (!argumentsDelta || !target.function.name) return;
  if (!announced.has(index)) {
    announced.add(index);
    notifyToolCallStart(callbacks, { index, name: target.function.name });
  }
  notifyToolCallArgumentsDelta(callbacks, { index, delta: argumentsDelta });
}

/**
 * Chat Completions' own stop reasons that mean "cut off" (#538).
 * @param {string|null} finishReason
 */
function cutOffOf(finishReason) {
  if (finishReason === 'length') return FINISH_REASONS.LENGTH;
  if (finishReason === 'content_filter') return FINISH_REASONS.CONTENT_FILTER;
  return null;
}

/**
 * @param {string} content
 * @param {Map<number, ToolCall>} toolCalls
 * @returns {AssistantMessage}
 */
function assistantMessageOf(content, toolCalls) {
  const complete = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc)
    .filter((tc) => tc?.function?.name);
  return {
    role: 'assistant',
    content: content.length > 0 ? content : complete.length ? null : '',
    ...(complete.length ? { tool_calls: complete } : {}),
  };
}

/**
 * Modellliste über `GET {base}/models`; Form ist bei allen Servern dieselbe.
 *
 * @param {Object} options
 * @param {string} options.baseUrl
 * @param {Record<string, string>} [options.headers]
 * @param {AbortSignal} [options.signal]
 * @param {import('undici').Dispatcher} [options.dispatcher]
 * @param {(model: { id: string, label: string }) => boolean} [options.filter]
 * @param {string|null} [options.serverName]  names the server in the message when its answer is unusable
 * @returns {Promise<{ models?: Array<{ id: string, label: string }>, error?: import('../../shared/contracts/message').Message|string }>}
 */
async function listChatModels({ baseUrl, headers = {}, signal, dispatcher, filter, serverName = null }) {
  let res;
  try {
    res = await fetchVia(`${baseUrl}/models`, { headers, signal, ...(dispatcher ? { dispatcher } : {}) });
  } catch (err) {
    return { error: describeFetchErrorMessage(err, baseUrl) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!isRecord(json) || !Array.isArray(json.data)) {
    return {
      error: serverName
        ? createMessage('provider.error.unexpectedAnswer.server', { provider: serverName })
        : createMessage('provider.error.unexpectedAnswer.generic'),
    };
  }
  const models = json.data
    .map((/** @type {unknown} */ m) => (isRecord(m) && typeof m.id === 'string' ? { id: m.id, label: m.id } : null))
    .filter((m) => m !== null)
    .filter((m) => (typeof filter === 'function' ? filter(m) : true))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

/**
 * Eine Chat-Runde gegen `{baseUrl}/chat/completions`.
 *
 * `sendTools: false` laesst das Feld `tools` weg — fuer Server, die an
 * Tool-Schemata scheitern (Issue #193). `onHttpStatus` sieht den Status vor der
 * Fehlerauswertung; der generische Provider erkennt daran den Rückfall.
 *
 * `maxOutputTokens` goes out as `max_tokens` (#931): the field every
 * OpenAI-compatible server knows. `max_completion_tokens` is only what OpenAI's
 * own reasoning models insist on, and those are reached through the OpenAI
 * provider, not this transport. A limit in `extraBody`, under either name, wins.
 *
 * @param {ChatCompletionsRoundOptions} options
 * @returns {Promise<ChatRoundResult>}
 */
async function streamChatCompletionsRound({
  baseUrl,
  headers,
  model,
  messages,
  tools,
  callbacks,
  abortSignal,
  dispatcher,
  supportsImages = false,
  sendTools = true,
  callIdPrefix = 'call_',
  maxOutputTokens,
  extraBody,
}) {
  const extra = extraBody && typeof extraBody === 'object' ? extraBody : {};
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    messages: translateMessagesToChatCompletions(messages, { supportsImages }),
    stream: true,
    // Ohne diese Bitte streamt die API gar keine Usage — die Anzeige bliebe
    // dann auch bei Servern leer, die sie liefern koennten (Issue #189).
    stream_options: { include_usage: true },
    ...extra,
  };
  if (isMaxOutputTokens(maxOutputTokens) && !('max_tokens' in extra) && !('max_completion_tokens' in extra)) {
    body.max_tokens = maxOutputTokens;
  }
  const chatTools = sendTools ? translateToolsToChatCompletions(tools) : undefined;
  if (chatTools) {
    body.tools = chatTools;
    body.tool_choice = 'auto';
  }

  const url = `${baseUrl}/chat/completions`;
  let res;
  try {
    res = await fetchVia(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) return cancelledChatRound({ role: 'assistant', content: '' });
    return { error: describeFetchErrorMessage(err, baseUrl), code: 'NETWORK' };
  }

  if (!res.ok) return { error: await readErrorMessage(res), code: String(res.status) };
  if (!res.body) return { error: createMessage('provider.error.noStream'), code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);
  let content = '';
  /** @type {Map<number, ToolCall>} */
  const toolCalls = new Map();
  /** @type {Set<number>} */
  const announcedToolCalls = new Set();
  /** @type {string|null} */
  let finishReason = null;
  // `[DONE]` or a `finish_reason` closes a round; without either the stream
  // was cut off on the way (#538).
  let sawDone = false;
  /** @type {string|null} */
  let streamError = null;
  /** @type {ChatRoundResult['usage']} */
  let usage = null;

  try {
    for await (const evt of iterSseEvents(reader, abortSignal)) {
      abortIfRequested(abortSignal);
      const data = evt.data;
      if (data === '[DONE]') sawDone = true;
      if (!data || data === '[DONE]') continue;
      /** @type {ChatCompletionChunk} */
      let json;
      try { json = JSON.parse(data); } catch { continue; }

      if (json.error) {
        const failure = isRecord(json.error) ? json.error : null;
        streamError = String(failure?.message || failure?.code || json.error);
        continue;
      }

      const nextUsage = normalizeUsage(json.usage);
      if (nextUsage) usage = nextUsage;

      const choice = Array.isArray(json.choices) ? json.choices[0] : null;
      if (!choice) continue;
      const delta = choice.delta || {};

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        callbacks.onTextDelta(delta.content);
      }
      // A refusal is the answer the user gets to read, not an empty bubble (#538).
      if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
        content += delta.refusal;
        callbacks.onTextDelta(delta.refusal);
      }

      // Manche Server (vLLM, llama.cpp mit Reasoning-Modellen) streamen das
      // Nachdenken in einem eigenen Feld neben `content`.
      const reasoningDelta =
        typeof delta.reasoning_content === 'string' && delta.reasoning_content
          ? delta.reasoning_content
          : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
      if (reasoningDelta) callbacks.onReasoningDelta?.(reasoningDelta);

      if (Array.isArray(delta.tool_calls)) {
        callbacks.onMarkGenerating();
        for (const tc of delta.tool_calls) {
          announceToolCallDelta(
            callbacks,
            announcedToolCalls,
            applyToolCallDelta(toolCalls, tc, callIdPrefix)
          );
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  } catch (err) {
    if (isAbortError(err)) return cancelledChatRound(assistantMessageOf(content, toolCalls));
    throw err;
  } finally {
    unbindAbort();
    reader.releaseLock?.();
  }

  if (streamError) {
    return { error: streamError, code: 'API' };
  }

  const message = assistantMessageOf(content, toolCalls);
  return {
    message,
    finishReason: finishReason || sawDone
      ? finishReasonOf({ cutOff: cutOffOf(finishReason), toolCalls: !!message.tool_calls })
      : FINISH_REASONS.INCOMPLETE,
    usage,
  };
}

module.exports = {
  translateMessagesToChatCompletions,
  translateToolsToChatCompletions,
  listChatModels,
  streamChatCompletionsRound,
};
