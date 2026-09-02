const { iterSseEvents, describeFetchError, readErrorMessage, abortIfRequested, cancelledChatRound, isAbortError, bindAbortSignalToReader, normalizeUsage } = require('./stream-helpers');

const API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

function authHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
}

async function listModels(config) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: 'API-Key fehlt.' };
  let res;
  try {
    res = await fetch(`${API_BASE}/models?limit=100`, { headers: authHeaders(apiKey) });
  } catch (err) {
    return { error: describeFetchError(err, API_BASE) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.data)) {
    return { error: 'Unerwartete Antwort der Anthropic-API.' };
  }
  const models = json.data
    .map((m) => m && typeof m.id === 'string'
      ? { id: m.id, label: m.display_name || m.id }
      : null)
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

function translateToolsToAnthropic(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t?.function?.name) continue;
    out.push({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    });
  }
  return out.length ? out : undefined;
}

function isLikelyJsonString(s) {
  const t = String(s ?? '').trim();
  return t.length > 0 && (t[0] === '{' || t[0] === '[' || t === 'null' || t === 'true' || t === 'false' || /^-?\d/.test(t));
}

function translateMessagesToAnthropic(messages) {
  let system = '';
  const out = [];
  let pendingToolResults = null; // array of tool_result blocks to flush on next non-tool message
  // tool_use-IDs der letzten Assistant-Nachricht, die noch kein tool_result
  // referenziert hat — Fallback fuer tool-Messages ohne tool_call_id, denn
  // Anthropic lehnt tool_use_id: '' mit 400 ab.
  let unmatchedToolUseIds = [];

  const flushPendingToolResults = () => {
    if (pendingToolResults && pendingToolResults.length) {
      out.push({ role: 'user', content: pendingToolResults });
    }
    pendingToolResults = null;
  };

  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (m.content || '');
      continue;
    }
    if (m.role === 'tool') {
      let toolUseId = m.tool_call_id || '';
      if (toolUseId) {
        const idx = unmatchedToolUseIds.indexOf(toolUseId);
        if (idx !== -1) unmatchedToolUseIds.splice(idx, 1);
      } else {
        toolUseId = unmatchedToolUseIds.shift() || '';
      }
      if (!toolUseId) continue; // nicht zuordenbar — Block wuerde remote mit 400 scheitern
      const block = {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      };
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push(block);
      continue;
    }
    flushPendingToolResults();

    if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : '' });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      unmatchedToolUseIds = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc?.function?.name) continue;
          let input = {};
          const argStr = tc.function.arguments;
          if (typeof argStr === 'string' && argStr.trim()) {
            try { input = JSON.parse(argStr); } catch { input = {}; }
          }
          const toolUseId = tc.id || `tu_${Math.random().toString(36).slice(2)}`;
          unmatchedToolUseIds.push(toolUseId);
          blocks.push({
            type: 'tool_use',
            id: toolUseId,
            name: tc.function.name,
            input,
          });
        }
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
  }
  flushPendingToolResults();
  return { system: system || undefined, messages: out };
}

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal }) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: 'Kein API-Key hinterlegt.', code: 'NO_API_KEY' };

  const { system, messages: anthMessages } = translateMessagesToAnthropic(messages);
  const tooling = translateToolsToAnthropic(tools);
  const body = {
    model,
    max_tokens: DEFAULT_MAX_TOKENS,
    stream: true,
    messages: anthMessages,
  };
  if (system) body.system = system;
  if (tooling) body.tools = tooling;

  const url = `${API_BASE}/messages`;
  const headers = authHeaders(apiKey);

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

  // Accumulators per content block index
  const blocks = new Map(); // index -> { type, text?, toolCall: {id, name, args} }
  let textOut = '';
  let stopReason = null;
  let usage = null;

  try {
    for await (const evt of iterSseEvents(reader, abortSignal)) {
      abortIfRequested(abortSignal);
      if (!evt.data) continue;
      let payload;
      try { payload = JSON.parse(evt.data); } catch { continue; }
      const type = payload.type || evt.event;

      if (type === 'message_start') {
        const startUsage = normalizeUsage(payload.message?.usage);
        if (startUsage) {
          usage = usage || { prompt: 0, completion: 0, total: 0 };
          usage.prompt = startUsage.prompt;
          usage.completion = startUsage.completion;
          usage.total = usage.prompt + usage.completion;
        }
      } else if (type === 'content_block_start') {
        const idx = payload.index;
        const cb = payload.content_block || {};
        if (cb.type === 'text') {
          blocks.set(idx, { type: 'text', text: '' });
        } else if (cb.type === 'tool_use') {
          blocks.set(idx, {
            type: 'tool_use',
            toolCall: { id: cb.id, name: cb.name, args: '' },
          });
        } else if (cb.type === 'thinking') {
          blocks.set(idx, { type: 'thinking', text: '' });
        }
      } else if (type === 'content_block_delta') {
        const idx = payload.index;
        const block = blocks.get(idx);
        if (!block) continue;
        const d = payload.delta || {};
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          block.text = (block.text || '') + d.text;
          textOut += d.text;
          callbacks.onTextDelta(d.text);
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          if (block.toolCall) {
            block.toolCall.args += d.partial_json;
            callbacks.onMarkGenerating();
          }
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          block.text = (block.text || '') + d.thinking;
          callbacks.onReasoningDelta(d.thinking);
        }
      } else if (type === 'content_block_stop') {
        // no-op; data already accumulated
      } else if (type === 'message_delta') {
        const deltaUsage = normalizeUsage(payload.usage);
        if (deltaUsage) {
          usage = usage || { prompt: 0, completion: 0, total: 0 };
          if (deltaUsage.completion > 0) usage.completion = deltaUsage.completion;
          if (deltaUsage.prompt > 0) usage.prompt = deltaUsage.prompt;
          usage.total = usage.prompt + usage.completion;
        }
        const sr = payload.delta?.stop_reason;
        if (sr) stopReason = sr;
      } else if (type === 'message_stop') {
        // end
      } else if (type === 'error') {
        const msg = payload.error?.message || 'Anthropic-Stream-Fehler';
        return { error: msg, code: 'API' };
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      const orderedIndexes = [...blocks.keys()].sort((a, b) => a - b);
      const tool_calls = [];
      for (const idx of orderedIndexes) {
        const b = blocks.get(idx);
        if (b?.type === 'tool_use' && b.toolCall) {
          const args = b.toolCall.args || '';
          tool_calls.push({
            id: b.toolCall.id,
            type: 'function',
            function: {
              name: b.toolCall.name,
              arguments: isLikelyJsonString(args) ? args : '{}',
            },
          });
        }
      }
      return cancelledChatRound({
        role: 'assistant',
        content: textOut.length > 0 ? textOut : tool_calls.length ? null : '',
        ...(tool_calls.length ? { tool_calls } : {}),
      });
    }
    throw err;
  } finally {
    unbindAbort();
    reader.releaseLock?.();
  }

  // Build canonical tool_calls (preserve block order)
  const orderedIndexes = [...blocks.keys()].sort((a, b) => a - b);
  const tool_calls = [];
  for (const idx of orderedIndexes) {
    const b = blocks.get(idx);
    if (b?.type === 'tool_use' && b.toolCall) {
      const args = b.toolCall.args || '';
      tool_calls.push({
        id: b.toolCall.id,
        type: 'function',
        function: {
          name: b.toolCall.name,
          arguments: isLikelyJsonString(args) ? args : '{}',
        },
      });
    }
  }

  const message = {
    role: 'assistant',
    content: textOut.length > 0 ? textOut : tool_calls.length ? null : '',
    ...(tool_calls.length ? { tool_calls } : {}),
  };

  let finishReason = null;
  if (stopReason === 'tool_use') finishReason = 'tool_calls';
  else if (stopReason === 'end_turn') finishReason = 'stop';
  else if (stopReason) finishReason = stopReason;

  return { message, finishReason, usage };
}

module.exports = {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  fields: { apiKey: true },
  defaultModel: 'claude-sonnet-4-6',
  apiBase: API_BASE,
  presentation: {
    apiKeyPlaceholder: 'sk-ant-…',
  },
  listModels,
  streamChatRound,
  translateMessagesToAnthropic,
  translateToolsToAnthropic,
};
