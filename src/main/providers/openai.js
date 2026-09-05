const { iterSseEvents, describeFetchError, readErrorMessage, abortIfRequested, cancelledChatRound, isAbortError, bindAbortSignalToReader, normalizeUsage, notifyToolCallStart, notifyToolCallArgumentsDelta } = require('./stream-helpers');

const DEFAULT_BASE = 'https://api.openai.com/v1';

function baseUrlOf(config) {
  const raw = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  return (raw || DEFAULT_BASE).replace(/\/$/, '');
}

async function listModels(config) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: 'API-Key fehlt.' };
  const base = baseUrlOf(config);
  let res;
  try {
    res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return { error: describeFetchError(err, base) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.data)) {
    return { error: 'Unerwartete Antwort der OpenAI-API.' };
  }
  const models = json.data
    .map((m) => m && typeof m.id === 'string' ? { id: m.id, label: m.id } : null)
    .filter(Boolean)
    .filter((m) => !/whisper|tts|embedding|dall-e|moderation|davinci|babbage|curie|^ada/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

// Tools: Chat-Completions-Form ({type:"function", function:{name,description,parameters}})
// → Responses-Form (flach: {type:"function", name, description, parameters}).
function translateToolsToResponses(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const t of tools) {
    const fn = t?.function;
    if (!fn?.name) continue;
    out.push({
      type: 'function',
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
    });
  }
  return out.length ? out : undefined;
}

// Konversationsverlauf in Chat-Completions-Form
// (system/user/assistant + assistant.tool_calls + tool/tool_call_id) → Responses-input.
// Pro Round wird der gesamte Verlauf als Items uebergeben; previous_response_id
// nutzen wir nicht, weil der chat-handler den Verlauf bereits selbst pflegt.
function translateMessagesToResponsesInput(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' });
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

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal }) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: 'Kein API-Key hinterlegt.', code: 'NO_API_KEY' };

  const body = {
    model,
    input: translateMessagesToResponsesInput(messages),
    stream: true,
  };
  const respTools = translateToolsToResponses(tools);
  if (respTools) {
    body.tools = respTools;
    body.tool_choice = 'auto';
  }
  if (typeof config?.reasoningEffort === 'string' && config.reasoningEffort.trim()) {
    body.reasoning = { effort: config.reasoningEffort.trim() };
  }
  // Zusammenfassung des Nachdenkens mitstreamen (Issue #87): macht Minuten
  // lange Denkpausen als Zwischenschritte sichtbar. Standard aus, weil OpenAI
  // dafür je nach Organisation eine Verifizierung verlangt.
  if (config?.reasoningSummary === 'auto') {
    body.reasoning = { ...(body.reasoning || {}), summary: 'auto' };
  }

  const base = baseUrlOf(config);
  const url = `${base}/responses`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
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

  if (!res.ok) {
    return { error: await readErrorMessage(res), code: String(res.status) };
  }
  if (!res.body) return { error: 'Keine Stream-Antwort.', code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);
  const fullContentRef = { v: '' };
  const toolCalls = [];
  let finishReason = null;
  let streamError = null;
  let usage = null;

  try {
    for await (const evt of iterSseEvents(reader, abortSignal)) {
      abortIfRequested(abortSignal);
      const ev = evt.event || '';
      const data = evt.data;
      if (!data || data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }

      if (ev === 'response.output_text.delta') {
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
        if (delta) callbacks.onReasoningDelta(delta);
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
            id: item.call_id || item.id,
            type: 'function',
            function: {
              name: item.name || '',
              arguments: typeof item.arguments === 'string' ? item.arguments : '',
            },
          });
        }
        continue;
      }

      if (ev === 'response.completed') {
        finishReason = toolCalls.length ? 'tool_calls' : 'stop';
        usage = normalizeUsage(json.response?.usage);
        continue;
      }

      if (ev === 'response.error' || ev === 'error') {
        const errMsg =
          json.error?.message
          || (typeof json.message === 'string' ? json.message : '')
          || 'Fehler im Antwort-Stream.';
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
  const message = {
    role: 'assistant',
    content: fullContent.length > 0 ? fullContent : toolCalls.length ? null : '',
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  return { message, finishReason, usage };
}

module.exports = {
  id: 'openai',
  name: 'OpenAI',
  fields: { apiKey: true },
  defaultModel: 'gpt-4o-mini',
  apiBase: DEFAULT_BASE,
  presentation: {
    apiKeyPlaceholder: 'sk-…',
    presetFields: [
      {
        key: 'reasoningEffort',
        type: 'select',
        label: 'Reasoning',
        hint: 'reasoning_effort bei passenden OpenAI-Modellen.',
        defaultValue: 'medium',
        affectsPresetIdentity: true,
        detailStyle: 'mono',
        // Ohne Praefix: Der nackte Wert steht im Chat hinter dem Modellnamen
        // („OpenAI · gpt-5 · high“), der API-Parametername gehoert in den Hint.
        detailPrefix: '',
        showAsSuffix: true,
        options: [
          { value: 'low', label: 'low' },
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
        ],
        formatDetail: (value) => `${value}`,
      },
      {
        key: 'reasoningSummary',
        type: 'select',
        label: 'Reasoning-Zusammenfassung',
        hint:
          'Streamt eine Zusammenfassung des Nachdenkens als Zwischenschritte (reasoning.summary). '
          + 'Manche Organisationen müssen dafür bei OpenAI verifiziert sein; bei Fehlern auf „aus“ stellen.',
        defaultValue: 'off',
        affectsPresetIdentity: false,
        detailStyle: 'mono',
        options: [
          { value: 'off', label: 'aus' },
          { value: 'auto', label: 'auto' },
        ],
        // Nur „auto“ ist erwähnenswert; „aus“ soll das Preset-Sublabel nicht belegen.
        formatDetail: (value) => (value === 'auto' ? 'reasoning_summary: auto' : ''),
      },
    ],
  },
  listModels,
  streamChatRound,
};
