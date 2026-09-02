const { iterSseEvents, describeFetchError, readErrorMessage, safeJsonParse, abortIfRequested, cancelledChatRound, isAbortError, bindAbortSignalToReader, normalizeUsage, notifyToolCallStart } = require('./stream-helpers');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Model-IDs kommen teils aus User-Input (Settings) und landen im API-Pfad.
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function bareModelId(modelOrPath) {
  const s = String(modelOrPath || '').trim();
  if (s.startsWith('models/')) return s.slice('models/'.length);
  return s;
}

function isValidModelId(id) {
  return MODEL_ID_PATTERN.test(id);
}

async function listModels(config) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: 'API-Key fehlt.' };
  let res;
  try {
    res = await fetch(`${API_BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`);
  } catch (err) {
    return { error: describeFetchError(err, API_BASE) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.models)) {
    return { error: 'Unerwartete Antwort der Google-API.' };
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
      contents.push({ role: 'user', parts: [{ text: typeof m.content === 'string' ? m.content : '' }] });
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
          });
        }
      }
      if (parts.length === 0) parts.push({ text: '' });
      contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      const name = toolNameById.get(m.tool_call_id) || 'tool';
      // functionResponse.response muss ein Objekt sein. Unsere Tools liefern
      // immer JSON; der { result }-Fallback greift nur, falls je ein Tool
      // Plaintext zurückgibt, und verpackt ihn dann API-konform.
      const response = safeJsonParse(m.content, { result: m.content });
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response } }],
      });
      continue;
    }
  }

  return { systemText: systemText || null, contents };
}

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal }) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: 'Kein API-Key hinterlegt.', code: 'NO_API_KEY' };

  const modelId = bareModelId(model);
  if (!isValidModelId(modelId)) {
    return { error: `Ungültige Modell-ID: „${String(model || '')}“.`, code: 'INVALID' };
  }

  const { systemText, contents } = translateMessagesToGoogle(messages);
  const tooling = translateToolsToGoogle(tools);
  const body = { contents };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  if (tooling) body.tools = tooling;

  const url = `${API_BASE}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const headers = { 'Content-Type': 'application/json' };
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
    return { error: describeFetchError(err, API_BASE), code: 'NETWORK' };
  }
  if (!res.ok) return { error: await readErrorMessage(res), code: String(res.status) };
  if (!res.body) return { error: 'Keine Stream-Antwort.', code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);
  let textOut = '';
  const collectedToolCalls = [];
  let finishReason = null;
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
      const cand = payload.candidates?.[0];
      if (!cand) continue;
      const parts = cand.content?.parts || [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text.length > 0) {
          textOut += p.text;
          callbacks.onTextDelta(p.text);
        } else if (p.thought === true && typeof p.text === 'string') {
          callbacks.onReasoningDelta(p.text);
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
          });
        }
      }
      if (cand.finishReason) {
        const fr = String(cand.finishReason).toUpperCase();
        if (fr === 'STOP') finishReason = 'stop';
        else if (fr === 'TOOL_CALLS') finishReason = 'tool_calls';
        else if (fr === 'MALFORMED_FUNCTION_CALL') malformedFunctionCall = true;
        else finishReason = cand.finishReason;
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
      error: 'Das Modell hat einen ungültigen Function-Call erzeugt (MALFORMED_FUNCTION_CALL). Bitte erneut senden oder die Anfrage umformulieren.',
      code: 'API',
      usage,
    };
  }

  if (collectedToolCalls.length > 0 && !finishReason) {
    finishReason = 'tool_calls';
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
