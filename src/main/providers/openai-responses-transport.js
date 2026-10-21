/**
 * Transport für die **Responses**-API (`POST {base}/responses`).
 *
 * Gemeinsame Grundlage von `openai.js` und `openai-compatible.js` (Issue #193).
 * Wie der Chat-Completions-Transport kennt der Baustein keine gespeicherte
 * Konfiguration: Header und Base-URL kommen fertig herein.
 */
'use strict';

/** @typedef {import('../../application/ports/llm-port').LlmMessage} LlmMessage */
/** @typedef {import('../../application/ports/llm-port').LlmToolDefinition} LlmToolDefinition */
/** @typedef {import('../ports/provider-runtime-port').StreamCallbacks} StreamCallbacks */
/** @typedef {import('../ports/provider-runtime-port').ChatRoundResult} ChatRoundResult */
/** @typedef {NonNullable<import('../ports/provider-runtime-port').AssistantMessage['tool_calls']>[number]} ToolCall */

/**
 * What of a streamed Responses event is read.
 * @typedef {Object} ResponsesEvent
 * @property {unknown} [delta]
 * @property {number|string} [output_index]
 * @property {{ type?: string, name?: string, call_id?: string, id?: string, arguments?: unknown }} [item]
 * @property {{ incomplete_details?: { reason?: string }, usage?: unknown, error?: { message?: string } }} [response]
 * @property {{ message?: string }} [error]
 * @property {unknown} [message]
 *
 * @typedef {Object} ResponsesRoundOptions
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
 * @property {boolean} [includeStatus]  an error result carries the HTTP status
 * @property {number} [maxOutputTokens]
 * @property {Record<string, unknown>} [extraBody]
 */

const { imageAttachmentsOf, toDataUrl } = require('../../shared/contracts/attachments');
const { createMessage } = require('../../shared/contracts/message');
const { FINISH_REASONS, finishReasonOf } = require('../../shared/contracts/finish-reason');
const { isMaxOutputTokens } = require('../../shared/contracts/settings');
const { fetchVia } = require('../services/dispatcher-fetch');
const {
  iterSseEvents,
  describeFetchErrorMessage,
  readErrorDetails,
  abortIfRequested,
  cancelledChatRound,
  isAbortError,
  bindAbortSignalToReader,
  normalizeUsage,
  notifyToolCallStart,
  notifyToolCallArgumentsDelta,
} = require('./stream-helpers');

// Tools: Chat-Completions-Form ({type:"function", function:{name,description,parameters}})
// → Responses-Form (flach: {type:"function", name, description, parameters}).
/**
 * @param {LlmToolDefinition[]|undefined} tools
 * @returns {Array<Record<string, unknown>>|undefined}
 */
function translateToolsToResponses(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const t of tools) {
    const fn = t?.function;
    if (!fn?.name) continue;
    out.push({
      type: 'function',
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
      // Without it the Responses API treats the function as strict, and in
      // strict mode every property is required: the model fills in every
      // optional parameter, and tools with exclusive modes — read_file_lines
      // (lines or bytes), apply_patch (edits or patch) — refuse the call
      // (#766). The schemas are written for optional parameters.
      strict: false,
    });
  }
  return out.length ? out : undefined;
}

// Konversationsverlauf in Chat-Completions-Form
// (system/user/assistant + assistant.tool_calls + tool/tool_call_id) → Responses-input.
// Pro Round wird der gesamte Verlauf als Items uebergeben; previous_response_id
// nutzen wir nicht, weil der chat-handler den Verlauf bereits selbst pflegt.
/**
 * @param {LlmMessage[]} messages
 * @param {{ supportsImages?: boolean }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
function translateMessagesToResponsesInput(messages, { supportsImages = true } = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : '';
      const images = supportsImages && m.role === 'user' ? imageAttachmentsOf(m) : [];
      if (images.length === 0) {
        out.push({ role: m.role, content: text });
        continue;
      }
      // Mit Bild verlangt die Responses-API getypte Teile statt eines
      // Strings (Issue #84). Ein leerer Text-Teil entfaellt — ein Screenshot
      // ohne Begleitfrage ist eine gueltige Eingabe.
      /** @type {Array<Record<string, unknown>>} */
      const content = [];
      if (text) content.push({ type: 'input_text', text });
      for (const image of images) {
        content.push({ type: 'input_image', image_url: toDataUrl(image) });
      }
      out.push({ role: m.role, content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) out.push({ role: 'assistant', content: text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          out.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function?.name || '',
            arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : '',
          });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      const output = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      out.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output,
      });
    }
  }
  return out;
}

/**
 * Eine Chat-Runde gegen `{baseUrl}/responses`.
 *
 * Mit `includeStatus` traegt der Fehlerfall zusaetzlich den HTTP-Status — der
 * generische Provider erkennt daran, ob er einmalig auf Chat Completions
 * zurueckfallen soll (Issue #193). Ohne das Flag bleibt die Ergebnisform
 * unveraendert die der uebrigen Provider.
 *
 * @param {ResponsesRoundOptions} options
 * @returns {Promise<ChatRoundResult>}
 */
async function streamResponsesRound({
  baseUrl,
  headers,
  model,
  messages,
  tools,
  callbacks,
  abortSignal,
  dispatcher,
  supportsImages = true,
  sendTools = true,
  includeStatus = false,
  maxOutputTokens,
  extraBody,
}) {
  const extra = extraBody && typeof extraBody === 'object' ? extraBody : {};
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    input: translateMessagesToResponsesInput(messages, { supportsImages }),
    stream: true,
    ...extra,
  };
  // The output limit (#931); one set in `extraBody` wins.
  if (isMaxOutputTokens(maxOutputTokens) && !('max_output_tokens' in extra)) {
    body.max_output_tokens = maxOutputTokens;
  }
  const respTools = sendTools ? translateToolsToResponses(tools) : undefined;
  if (respTools) {
    body.tools = respTools;
    body.tool_choice = 'auto';
  }

  const url = `${baseUrl}/responses`;
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

  if (!res.ok) {
    const { message, param } = await readErrorDetails(res);
    return {
      error: message,
      code: String(res.status),
      // The request field the API objects to, so a provider can put its own
      // rejections into words (#718).
      ...(param ? { param } : {}),
      ...(includeStatus ? { status: res.status } : {}),
    };
  }
  if (!res.body) return { error: createMessage('provider.error.noStream'), code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);
  const fullContentRef = { v: '' };
  /** @type {ToolCall[]} */
  const toolCalls = [];
  // A round ends with `response.completed` or `response.incomplete`; a stream
  // that stops before either was cut off on the way (#538).
  let ended = false;
  /** @type {string|null} */
  let cutOff = null;
  /** @type {string|import('../../shared/contracts/message').Message|null} */
  let streamError = null;
  /** @type {ChatRoundResult['usage']} */
  let usage = null;

  try {
    for await (const evt of iterSseEvents(reader, abortSignal)) {
      abortIfRequested(abortSignal);
      const ev = evt.event || '';
      const data = evt.data;
      if (!data || data === '[DONE]') continue;
      /** @type {ResponsesEvent} */
      let json;
      try { json = JSON.parse(data); } catch { continue; }

      // A refusal is the answer the user gets to read, not an empty bubble (#538).
      if (ev === 'response.output_text.delta' || ev === 'response.refusal.delta') {
        const delta = typeof json.delta === 'string' ? json.delta : '';
        if (delta) {
          fullContentRef.v += delta;
          callbacks.onTextDelta(delta);
        }
        continue;
      }

      // OpenAI streamt Reasoning unter mehreren Event-Namen je nach Modell.
      if (
        ev === 'response.reasoning_summary_text.delta'
        || ev === 'response.reasoning_text.delta'
        || ev === 'response.reasoning.delta'
      ) {
        const delta = typeof json.delta === 'string' ? json.delta : '';
        if (delta) callbacks.onReasoningDelta?.(delta);
        continue;
      }

      if (ev === 'response.output_item.added') {
        if (json.item?.type === 'function_call') {
          callbacks.onMarkGenerating();
          notifyToolCallStart(callbacks, { index: json.output_index, name: json.item.name || '' });
        }
        continue;
      }

      if (ev === 'response.function_call_arguments.delta') {
        if (typeof json.delta === 'string' && json.delta) {
          notifyToolCallArgumentsDelta(callbacks, { index: json.output_index, delta: json.delta });
        }
        continue;
      }

      if (ev === 'response.output_item.done') {
        const item = json.item;
        if (item?.type === 'function_call') {
          toolCalls.push({
            id: item.call_id || item.id || '',
            type: 'function',
            function: {
              name: item.name || '',
              arguments: typeof item.arguments === 'string' ? item.arguments : '',
            },
          });
        }
        continue;
      }

      if (ev === 'response.completed' || ev === 'response.incomplete') {
        ended = true;
        if (ev === 'response.incomplete') {
          cutOff = json.response?.incomplete_details?.reason === 'content_filter'
            ? FINISH_REASONS.CONTENT_FILTER
            : FINISH_REASONS.LENGTH;
        }
        usage = normalizeUsage(json.response?.usage);
        continue;
      }

      if (ev === 'response.failed') {
        streamError = json.response?.error?.message || createMessage('provider.error.streamFailed');
        continue;
      }

      if (ev === 'response.error' || ev === 'error') {
        const errMsg =
          json.error?.message
          || (typeof json.message === 'string' ? json.message : '')
          || createMessage('provider.error.streamFailed');
        streamError = errMsg;
        continue;
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      return cancelledChatRound({
        role: 'assistant',
        content: fullContentRef.v.length > 0 ? fullContentRef.v : toolCalls.length ? null : '',
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
    throw err;
  } finally {
    unbindAbort();
    reader.releaseLock?.();
  }

  if (streamError) {
    return { error: streamError, code: 'API' };
  }

  const fullContent = fullContentRef.v;
  /** @type {import('../ports/provider-runtime-port').AssistantMessage} */
  const message = {
    role: 'assistant',
    content: fullContent.length > 0 ? fullContent : toolCalls.length ? null : '',
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  const finishReason = ended
    ? finishReasonOf({ cutOff, toolCalls: toolCalls.length > 0 })
    : FINISH_REASONS.INCOMPLETE;
  return { message, finishReason, usage };
}

module.exports = {
  translateToolsToResponses,
  translateMessagesToResponsesInput,
  streamResponsesRound,
};
