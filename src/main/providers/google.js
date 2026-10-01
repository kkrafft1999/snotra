const { withRequestTimeout, userMessageOf, CLOUD_MODELS_TIMEOUT_MS } = require('../services/request-timeout');
const { createMessage } = require('../../shared/contracts/message');
const { FINISH_REASONS, finishReasonOf } = require('../../shared/contracts/finish-reason');
const { iterSseEvents, describeFetchErrorMessage, readErrorMessage, safeJsonParse, abortIfRequested, cancelledChatRound, isAbortError, bindAbortSignalToReader, normalizeUsage, notifyToolCallStart } = require('./stream-helpers');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Model-IDs kommen teils aus User-Input (Settings) und landen im API-Pfad.
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

// The key goes in a header, not in the URL: URLs end up in proxy logs and
// error output where headers do not (#541).
function authHeaders(apiKey) {
  return { 'x-goog-api-key': apiKey };
}

function bareModelId(modelOrPath) {
  const s = String(modelOrPath || '').trim();
  if (s.startsWith('models/')) return s.slice('models/'.length);
  return s;
}

// Gemini's finish reasons that mean "cut off" (#538); STOP and the rest end a
// round normally.
const LENGTH_REASONS = new Set(['MAX_TOKENS']);
const FILTER_REASONS = new Set([
  'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY',
]);

function cutOffOf(finishReason) {
  if (LENGTH_REASONS.has(finishReason)) return FINISH_REASONS.LENGTH;
  if (FILTER_REASONS.has(finishReason)) return FINISH_REASONS.CONTENT_FILTER;
  return null;
}

function isValidModelId(id) {
  return MODEL_ID_PATTERN.test(id);
}

async function listModels(config) {
  try {
    return await withRequestTimeout((signal) => listModelsRequest({ ...config, signal }), {
      signal: config?.signal,
      timeoutMs: config?.timeoutMs ?? CLOUD_MODELS_TIMEOUT_MS,
    });
  } catch (err) {
    return { error: userMessageOf(err) };
  }
}

async function listModelsRequest(config) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: createMessage('provider.error.noApiKey') };
  let res;
  try {
    res = await fetch(`${API_BASE}/models?pageSize=200`, { headers: authHeaders(apiKey), signal: config.signal });
  } catch (err) {
    return { error: describeFetchErrorMessage(err, API_BASE) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.models)) {
    return { error: createMessage('provider.error.unexpectedAnswer.api', { provider: 'Google' }) };
  }
  const models = json.models
    .filter((m) => Array.isArray(m.supportedGenerationMethods)
      && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => {
      const id = bareModelId(m.name);
      return { id, label: m.displayName ? `${m.displayName} (${id})` : id };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

function translateToolsToGoogle(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const decls = [];
  for (const t of tools) {
    if (!t?.function?.name) continue;
    decls.push({
      name: t.function.name,
      description: t.function.description || '',
      parameters: stripUnsupportedSchemaFields(t.function.parameters || { type: 'object', properties: {} }),
    });
  }
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

// Gemini's function-declaration schema accepts a subset of JSON Schema.
// Strip fields that often cause 400 errors.
function stripUnsupportedSchemaFields(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const cleaned = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'additionalProperties') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props = {};
      for (const [pk, pv] of Object.entries(v)) {
        props[pk] = stripUnsupportedSchemaFields(pv);
      }
      cleaned[k] = props;
    } else if (k === 'items') {
      cleaned[k] = stripUnsupportedSchemaFields(v);
    } else {
      cleaned[k] = v;
    }
  }
  return cleaned;
}

function buildToolCallNameMap(messages) {
  const map = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) map.set(tc.id, tc.function.name);
      }
    }
  }
  return map;
}


/**
 * Turns alternate: a turn of the same role as the one before joins it. That
 * keeps the history valid when an empty answer was left out, and gives the
 * responses to parallel calls one turn, as the API expects them (#540).
 */
function pushContent(contents, role, parts) {
  const last = contents[contents.length - 1];
  if (last?.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

function translateMessagesToGoogle(messages) {
  const toolNameById = buildToolCallNameMap(messages);
  let systemText = '';
  const contents = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + (m.content || '');
      continue;
    }
    if (m.role === 'user') {
      pushContent(contents, 'user', [{ text: typeof m.content === 'string' ? m.content : '' }]);
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        parts.push({ text: m.content });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc?.function?.name) continue;
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: safeJsonParse(tc.function.arguments, {}),
            },
            // Gemini 3 refuses the next round of a tool loop without the
            // signature it attached to the call (#540).
            ...(typeof tc.thoughtSignature === 'string' && tc.thoughtSignature
              ? { thoughtSignature: tc.thoughtSignature }
              : {}),
          });
        }
      }
      // A turn stopped before its first token has nothing to say (#540).
      if (parts.length > 0) pushContent(contents, 'model', parts);
      continue;
    }
    if (m.role === 'tool') {
      const name = toolNameById.get(m.tool_call_id) || 'tool';
      // functionResponse.response muss ein Objekt sein. Unsere Tools liefern
      // immer JSON; der { result }-Fallback greift nur, falls je ein Tool
      // Plaintext zurückgibt, und verpackt ihn dann API-konform.
      const response = safeJsonParse(m.content, { result: m.content });
      pushContent(contents, 'user', [{ functionResponse: { name, response } }]);
      continue;
    }
  }

  return { systemText: systemText || null, contents };
}

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal }) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: createMessage('provider.error.noApiKey'), code: 'NO_API_KEY' };

  const modelId = bareModelId(model);
  if (!isValidModelId(modelId)) {
    return { error: createMessage('provider.error.invalidModelId', { model: String(model || '') }), code: 'INVALID' };
  }

  const { systemText, contents } = translateMessagesToGoogle(messages);
  const tooling = translateToolsToGoogle(tools);
  const body = { contents };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  if (tooling) body.tools = tooling;

  const url = `${API_BASE}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;

  const headers = { 'Content-Type': 'application/json', ...authHeaders(apiKey) };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    });
  } catch (err) {
    if (isAbortError(err)) return cancelledChatRound({ role: 'assistant', content: '' });
    return { error: describeFetchErrorMessage(err, API_BASE), code: 'NETWORK' };
  }
  if (!res.ok) return { error: await readErrorMessage(res), code: String(res.status) };
  if (!res.body) return { error: createMessage('provider.error.noStream'), code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);
  let textOut = '';
  const collectedToolCalls = [];
  // The last chunk of a round carries a finish reason; a stream without one
  // was cut off on the way (#538). A prompt the API blocked has no candidate.
  let rawFinishReason = null;
  let promptBlocked = false;
  let usage = null;
  let malformedFunctionCall = false;

  try {
    for await (const evt of iterSseEvents(reader, abortSignal)) {
      abortIfRequested(abortSignal);
      if (!evt.data) continue;
      let payload;
      try { payload = JSON.parse(evt.data); } catch { continue; }
      const nextUsage = normalizeUsage(payload.usageMetadata);
      if (nextUsage) usage = nextUsage;
      if (payload.promptFeedback?.blockReason) promptBlocked = true;
      const cand = payload.candidates?.[0];
      if (!cand) continue;
      const parts = cand.content?.parts || [];
      for (const p of parts) {
        // A thought part carries its text in `text` as well, so it is checked
        // first — otherwise the thinking would stream as the answer (#541).
        if (p.thought === true) {
          if (typeof p.text === 'string' && p.text) callbacks.onReasoningDelta?.(p.text);
        } else if (typeof p.text === 'string' && p.text.length > 0) {
          textOut += p.text;
          callbacks.onTextDelta(p.text);
        } else if (p.functionCall) {
          callbacks.onMarkGenerating();
          const fc = p.functionCall;
          notifyToolCallStart(callbacks, {
            index: collectedToolCalls.length,
            name: String(fc.name || ''),
            args: fc.args && typeof fc.args === 'object' ? fc.args : {},
          });
          collectedToolCalls.push({
            id: `gcall_${collectedToolCalls.length}_${Date.now().toString(36)}`,
            type: 'function',
            function: {
              name: String(fc.name || ''),
              arguments: JSON.stringify(fc.args ?? {}),
            },
            // Travels with the call through the tool loop and goes back on the
            // same part (#540).
            ...(typeof p.thoughtSignature === 'string' && p.thoughtSignature
              ? { thoughtSignature: p.thoughtSignature }
              : {}),
          });
        }
      }
      if (cand.finishReason) {
        rawFinishReason = String(cand.finishReason).toUpperCase();
        if (rawFinishReason === 'MALFORMED_FUNCTION_CALL') malformedFunctionCall = true;
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      return cancelledChatRound({
        role: 'assistant',
        content: textOut.length > 0 ? textOut : collectedToolCalls.length ? null : '',
        ...(collectedToolCalls.length ? { tool_calls: collectedToolCalls } : {}),
      });
    }
    throw err;
  } finally {
    unbindAbort();
    reader.releaseLock?.();
  }

  if (malformedFunctionCall) {
    return {
      error: createMessage('provider.error.malformedFunctionCall'),
      code: 'API',
      usage,
    };
  }

  let finishReason = FINISH_REASONS.INCOMPLETE;
  if (promptBlocked) finishReason = FINISH_REASONS.CONTENT_FILTER;
  else if (rawFinishReason) {
    finishReason = finishReasonOf({
      cutOff: cutOffOf(rawFinishReason),
      toolCalls: collectedToolCalls.length > 0,
    });
  }

  const message = {
    role: 'assistant',
    content: textOut.length > 0 ? textOut : collectedToolCalls.length ? null : '',
    ...(collectedToolCalls.length ? { tool_calls: collectedToolCalls } : {}),
  };
  return { message, finishReason, usage };
}

module.exports = {
  id: 'google',
  name: 'Google (Gemini)',
  fields: { apiKey: true },
  // Auf true, sobald translateMessagesToGoogle Bilder abbildet (Issue #91).
  capabilities: { images: false },
  defaultModel: 'gemini-2.0-flash',
  apiBase: API_BASE,
  presentation: {
    apiKeyPlaceholder: 'AIza…',
  },
  listModels,
  streamChatRound,
  translateMessagesToGoogle,
  translateToolsToGoogle,
};
