const { iterSseEvents, describeFetchError, readErrorMessage, abortIfRequested, cancelledChatRound, isAbortError, bindAbortSignalToReader, normalizeUsage } = require('./stream-helpers');

const DEFAULT_BASE = 'http://127.0.0.1:8080/v1';

function baseUrlOf(config) {
  const raw = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  return (raw || DEFAULT_BASE).replace(/\/$/, '');
}

async function listModels(config) {
  const base = baseUrlOf(config);
  let res;
  try {
    res = await fetch(`${base}/models`);
  } catch (err) {
    return { error: describeFetchError(err, base) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.data)) {
    return { error: 'Unerwartete Antwort des MLX-LM-Servers.' };
  }
  const models = json.data
    .map((m) => m && typeof m.id === 'string' ? { id: m.id, label: m.id } : null)
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

function translateMessagesToChatCompletions(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' });
      continue;
    }
    if (m.role === 'assistant') {
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

function translateToolsToChatCompletions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
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

function applyToolCallDelta(toolCalls, deltaToolCall) {
  const index = Number.isInteger(deltaToolCall?.index) ? deltaToolCall.index : toolCalls.length;
  if (!toolCalls[index]) {
    toolCalls[index] = {
      id: deltaToolCall?.id || `mlx_call_${index}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: '', arguments: '' },
    };
  }

  const target = toolCalls[index];
  if (deltaToolCall.id) target.id = deltaToolCall.id;
  if (deltaToolCall.type) target.type = deltaToolCall.type;
  if (deltaToolCall.function?.name) target.function.name += deltaToolCall.function.name;
  if (typeof deltaToolCall.function?.arguments === 'string') {
    target.function.arguments += deltaToolCall.function.arguments;
  }
}

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal }) {
  const body = {
    model,
    messages: translateMessagesToChatCompletions(messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  const chatTools = translateToolsToChatCompletions(tools);
  if (chatTools) {
    body.tools = chatTools;
    body.tool_choice = 'auto';
  }

  const base = baseUrlOf(config);
  const url = `${base}/chat/completions`;
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
    return { error: describeFetchError(err, base), code: 'NETWORK' };
  }

  if (!res.ok) return { error: await readErrorMessage(res), code: String(res.status) };
  if (!res.body) return { error: 'Keine Stream-Antwort.', code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);
  let content = '';
  const toolCalls = [];
  let finishReason = null;
  let streamError = null;
  let usage = null;

  try {
    for await (const evt of iterSseEvents(reader, abortSignal)) {
      abortIfRequested(abortSignal);
      const data = evt.data;
      if (!data || data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }

      if (json.error) {
        streamError = json.error?.message || json.error?.code || String(json.error);
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

      if (Array.isArray(delta.tool_calls)) {
        callbacks.onMarkGenerating();
        for (const tc of delta.tool_calls) applyToolCallDelta(toolCalls, tc);
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      const completeToolCalls = toolCalls.filter((tc) => tc?.function?.name);
      return cancelledChatRound({
        role: 'assistant',
        content: content.length > 0 ? content : completeToolCalls.length ? null : '',
        ...(completeToolCalls.length ? { tool_calls: completeToolCalls } : {}),
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

  const completeToolCalls = toolCalls.filter((tc) => tc?.function?.name);
  const message = {
    role: 'assistant',
    content: content.length > 0 ? content : completeToolCalls.length ? null : '',
    ...(completeToolCalls.length ? { tool_calls: completeToolCalls } : {}),
  };
  return {
    message,
    finishReason: completeToolCalls.length ? 'tool_calls' : (finishReason || 'stop'),
    usage,
  };
}

module.exports = {
  id: 'mlx-lm',
  name: 'MLX-LM (lokal)',
  fields: { baseUrl: true },
  defaultModel: '',
  defaultBaseUrl: DEFAULT_BASE,
  apiBase: DEFAULT_BASE,
  presentation: {
    baseUrlPlaceholder: DEFAULT_BASE,
    connectionDetail: true,
  },
  listModels,
  streamChatRound,
};
