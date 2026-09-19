/**
 * Transport für die **Chat-Completions**-API (`POST {base}/chat/completions`).
 *
 * Gemeinsame Grundlage von `mlx-lm.js` und `openai-compatible.js` (Issue #193).
 * Der Baustein kennt weder Anbieter-IDs noch gespeicherte Konfiguration: Er
 * bekommt fertige Header, eine Base-URL und die Nachrichten und liefert ein
 * `ChatRoundResult` zurück. Alles Anbieter-Eigene (welche Header, ob Bilder,
 * ob Tools) entscheidet der Aufrufer.
 */
'use strict';

const { imageAttachmentsOf, toDataUrl } = require('../../shared/contracts/attachments');
const {
  iterSseEvents,
  describeFetchError,
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
 */
function translateMessagesToChatCompletions(messages, { supportsImages = false } = {}) {
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
      const content = [];
      if (textContent) content.push({ type: 'text', text: textContent });
      for (const image of images) {
        content.push({ type: 'image_url', image_url: { url: toDataUrl(image) } });
      }
      out.push({ role: m.role, content });
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

function applyToolCallDelta(toolCalls, deltaToolCall, callIdPrefix) {
  const index = Number.isInteger(deltaToolCall?.index) ? deltaToolCall.index : toolCalls.length;
  if (!toolCalls[index]) {
    toolCalls[index] = {
      id: deltaToolCall?.id || `${callIdPrefix}${index}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: '', arguments: '' },
    };
  }

  const target = toolCalls[index];
  if (deltaToolCall.id) target.id = deltaToolCall.id;
  if (deltaToolCall.type) target.type = deltaToolCall.type;
  if (deltaToolCall.function?.name) target.function.name += deltaToolCall.function.name;
  const argumentsDelta =
    typeof deltaToolCall.function?.arguments === 'string' ? deltaToolCall.function.arguments : '';
  if (argumentsDelta) target.function.arguments += argumentsDelta;
  return { index, target, argumentsDelta };
}

// Der Name kann in Stücken kommen; erst wenn Argumente eintreffen, ist er komplett.
// Deshalb wird der Aufruf beim ersten Argument-Stück gemeldet, nicht beim Namen.
function announceToolCallDelta(callbacks, announced, { index, target, argumentsDelta }) {
  if (!argumentsDelta || !target.function.name) return;
  if (!announced.has(index)) {
    announced.add(index);
    notifyToolCallStart(callbacks, { index, name: target.function.name });
  }
  notifyToolCallArgumentsDelta(callbacks, { index, delta: argumentsDelta });
}

function assistantMessageOf(content, toolCalls) {
  const complete = toolCalls.filter((tc) => tc?.function?.name);
  return {
    role: 'assistant',
    content: content.length > 0 ? content : complete.length ? null : '',
    ...(complete.length ? { tool_calls: complete } : {}),
  };
}

/** Modellliste über `GET {base}/models`; Form ist bei allen Servern dieselbe. */
async function listChatModels({ baseUrl, headers = {}, signal, dispatcher, filter, serverLabel = 'Servers' }) {
  let res;
  try {
    res = await fetch(`${baseUrl}/models`, { headers, signal, ...(dispatcher ? { dispatcher } : {}) });
  } catch (err) {
    return { error: describeFetchError(err, baseUrl) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.data)) {
    return { error: `Unerwartete Antwort des ${serverLabel}.` };
  }
  const models = json.data
    .map((m) => (m && typeof m.id === 'string' ? { id: m.id, label: m.id } : null))
    .filter(Boolean)
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
  extraBody,
}) {
  const body = {
    model,
    messages: translateMessagesToChatCompletions(messages, { supportsImages }),
    stream: true,
    // Ohne diese Bitte streamt die API gar keine Usage — die Anzeige bliebe
    // dann auch bei Servern leer, die sie liefern koennten (Issue #189).
    stream_options: { include_usage: true },
    ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
  };
  const chatTools = sendTools ? translateToolsToChatCompletions(tools) : undefined;
  if (chatTools) {
    body.tools = chatTools;
    body.tool_choice = 'auto';
  }

  const url = `${baseUrl}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) return cancelledChatRound({ role: 'assistant', content: '' });
    return { error: describeFetchError(err, baseUrl), code: 'NETWORK' };
  }

  if (!res.ok) return { error: await readErrorMessage(res), code: String(res.status) };
  if (!res.body) return { error: 'Keine Stream-Antwort.', code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);
  let content = '';
  const toolCalls = [];
  const announcedToolCalls = new Set();
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
    finishReason: message.tool_calls ? 'tool_calls' : (finishReason || 'stop'),
    usage,
  };
}

module.exports = {
  translateMessagesToChatCompletions,
  translateToolsToChatCompletions,
  listChatModels,
  streamChatCompletionsRound,
};
