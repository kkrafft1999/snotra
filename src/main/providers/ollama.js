const { Agent } = require('undici');
const { iterStreamLines, describeFetchError, readErrorMessage, safeJsonParse, abortIfRequested, cancelledChatRound, isAbortError, bindAbortSignalToReader, normalizeUsage, notifyToolCallStart } = require('./stream-helpers');

const DEFAULT_BASE = 'http://localhost:11434';

// Lazy gebauter undici-Agent, der TLS-Zertifikatspruefung deaktiviert. Wird
// pro Request nur dann verwendet, wenn der Nutzer im Provider-Modal "TLS-
// Zertifikat ignorieren (insecure)" aktiviert hat UND die Ziel-URL https ist.
// Analog zum Go-Referenz-CLI (Flag --insecure) fuer Server mit selbstsigniertem
// oder intern signiertem Zertifikat (z.B. https://ollama.intern.example).
let _insecureDispatcher = null;
const _warnedInsecureUrls = new Set();

function getInsecureDispatcher() {
  if (!_insecureDispatcher) {
    _insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return _insecureDispatcher;
}

function destroyInsecureDispatcher() {
  if (_insecureDispatcher) {
    _insecureDispatcher.close?.();
    _insecureDispatcher.destroy?.();
    _insecureDispatcher = null;
  }
}

function dispatcherFor(url, config) {
  if (!config?.insecureTls) return undefined;
  if (!url.startsWith('https://')) return undefined;
  if (!_warnedInsecureUrls.has(url)) {
    _warnedInsecureUrls.add(url);
    console.warn(`[ollama] TLS-Zertifikatsprüfung deaktiviert für ${url}`);
  }
  return getInsecureDispatcher();
}

function baseUrlOf(config) {
  const raw = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  return (raw || DEFAULT_BASE).replace(/\/$/, '');
}

async function listModels(config) {
  const base = baseUrlOf(config);
  const url = `${base}/api/tags`;
  let res;
  try {
    res = await fetch(url, { dispatcher: dispatcherFor(url, config) });
  } catch (err) {
    return { error: describeFetchError(err, base) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.models)) {
    return { error: 'Unerwartete Antwort des Ollama-Servers.' };
  }
  const models = json.models
    .map((m) => m && typeof m.name === 'string' ? { id: m.name, label: m.name } : null)
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

function translateMessagesToOllama(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' });
      continue;
    }
    if (m.role === 'assistant') {
      const row = {
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        row.tool_calls = m.tool_calls.map((tc) => ({
          function: {
            name: tc.function?.name || '',
            arguments: safeJsonParse(tc.function?.arguments, {}),
          },
        }));
      }
      out.push(row);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }
  }
  return out;
}

function translateToolsToOllama(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function?.name,
      description: t.function?.description || '',
      parameters: t.function?.parameters || { type: 'object', properties: {} },
    },
  }));
}

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal }) {
  const base = baseUrlOf(config);
  const url = `${base}/api/chat`;
  const body = {
    model,
    messages: translateMessagesToOllama(messages),
    stream: true,
  };
  const tooling = translateToolsToOllama(tools);
  if (tooling) body.tools = tooling;

  const headers = { 'Content-Type': 'application/json' };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      dispatcher: dispatcherFor(url, config),
      signal: abortSignal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      return cancelledChatRound({ role: 'assistant', content: '' });
    }
    return { error: describeFetchError(err, base), code: 'NETWORK' };
  }
  if (!res.ok) return { error: await readErrorMessage(res), code: String(res.status) };
  if (!res.body) return { error: 'Keine Stream-Antwort.', code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);
  let textOut = '';
  const collectedToolCalls = [];
  let finishReason = null;
  let usage = null;

  try {
    for await (const line of iterStreamLines(reader, abortSignal)) {
      abortIfRequested(abortSignal);
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload;
      try { payload = JSON.parse(trimmed); } catch { continue; }

      if (payload.error) {
        return { error: payload.error, code: 'API' };
      }

      const msg = payload.message;
      if (msg) {
        if (typeof msg.content === 'string' && msg.content.length > 0) {
          textOut += msg.content;
          callbacks.onTextDelta(msg.content);
        }
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name;
            if (!name) continue;
            const args = tc.function?.arguments;
            const argStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
            notifyToolCallStart(callbacks, {
              index: collectedToolCalls.length,
              name,
              args: typeof args === 'string' ? safeJsonParse(args, {}) : (args ?? {}),
            });
            collectedToolCalls.push({
              id: `ocall_${collectedToolCalls.length}_${Date.now().toString(36)}`,
              type: 'function',
              function: { name, arguments: argStr },
            });
            callbacks.onMarkGenerating();
          }
        }
      }
      if (payload.done === true) {
        finishReason = collectedToolCalls.length ? 'tool_calls' : (payload.done_reason || 'stop');
        usage = normalizeUsage(payload);
        break;
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

  const message = {
    role: 'assistant',
    content: textOut.length > 0 ? textOut : collectedToolCalls.length ? null : '',
    ...(collectedToolCalls.length ? { tool_calls: collectedToolCalls } : {}),
  };
  return { message, finishReason, usage };
}

module.exports = {
  id: 'ollama',
  name: 'Ollama (lokal)',
  fields: { baseUrl: true, insecureTls: true },
  defaultModel: 'llama3.2',
  defaultBaseUrl: DEFAULT_BASE,
  defaultInsecureTls: false,
  apiBase: DEFAULT_BASE,
  presentation: {
    baseUrlPlaceholder: 'http://localhost:11434',
    connectionDetail: true,
    insecureTlsHint: 'Nur bei selbstsigniertem oder intern signiertem Zertifikat, dem du vertraust.',
  },
  listModels,
  streamChatRound,
  translateMessagesToOllama,
  translateToolsToOllama,
  destroyInsecureDispatcher,
  dispose: destroyInsecureDispatcher,
};
