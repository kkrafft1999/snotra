const { withRequestTimeout, userMessageOf, LOCAL_MODELS_TIMEOUT_MS } = require('../services/request-timeout');
const { createMessage } = require('../../shared/contracts/message');
const { imageAttachmentsOf } = require('../../shared/contracts/attachments');
const { FINISH_REASONS, finishReasonOf } = require('../../shared/contracts/finish-reason');
const { Agent } = require('undici');
const { fetchVia } = require('../services/dispatcher-fetch');
const { iterStreamLines, describeFetchErrorMessage, readErrorMessage, safeJsonParse, abortIfRequested, cancelledChatRound, isAbortError, bindAbortSignalToReader, normalizeUsage, notifyToolCallStart } = require('./stream-helpers');

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
  try {
    return await withRequestTimeout((signal) => listModelsRequest({ ...config, signal }), {
      signal: config?.signal,
      timeoutMs: config?.timeoutMs ?? LOCAL_MODELS_TIMEOUT_MS,
    });
  } catch (err) {
    return { error: userMessageOf(err) };
  }
}

async function listModelsRequest(config) {
  const base = baseUrlOf(config);
  const url = `${base}/api/tags`;
  let res;
  try {
    res = await fetchVia(url, { dispatcher: dispatcherFor(url, config), signal: config.signal });
  } catch (err) {
    return { error: describeFetchErrorMessage(err, base) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.models)) {
    return { error: createMessage('provider.error.unexpectedAnswer.server', { provider: 'Ollama' }) };
  }
  const models = json.models
    .map((m) => m && typeof m.name === 'string' ? { id: m.name, label: m.name } : null)
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

/*
 * Reasoning levels (#994). Ollama takes `think` on /api/chat: a level word
 * for the models that know levels (gpt-oss: low, medium, high), true or
 * false for the others that think. Which model thinks is in `/api/show`, not
 * in the model list, so the families are recognised by name; a model that
 * turns out not to think is asked once more without `think` (see
 * streamChatRound). What a model thinks streams back in `message.thinking`.
 */
const LEVEL_FAMILIES = /^gpt-oss(?:[:\-]|$)/;
const THINKING_FAMILIES = [
  /^deepseek-r1(?:[:\-]|$)/,
  /^deepseek-v3\.[1-9]/,
  /^qwen3(?:\.\d+)?(?!-?(?:coder|embedding|instruct))(?:[:\-]|$)/,
  /^qwq(?:[:\-]|$)/,
  /^magistral(?:[:\-]|$)/,
  /^phi4-(?:mini-)?reasoning(?:[:\-]|$)/,
  /^kimi-k2-thinking(?:[:\-]|$)/,
  /^glm-(?:4\.[6-9]|[5-9])/,
];
const THINK_LEVELS = ['low', 'medium', 'high'];
// A model that can only think or not: two positions, off and on.
const THINK_SWITCH = ['none', 'on'];

/** The bare model name: `hf.co/org/qwen3:8b` → `qwen3:8b`, lower case. */
function bareModelName(model) {
  const id = String(model ?? '').trim().toLowerCase();
  return id.slice(id.lastIndexOf('/') + 1);
}

function reasoningLevelsOf(model) {
  const name = bareModelName(model);
  if (LEVEL_FAMILIES.test(name)) return THINK_LEVELS;
  if (THINKING_FAMILIES.some((re) => re.test(name)) && !/-instruct/.test(name)) return THINK_SWITCH;
  return [];
}

/** The `think` value for a level; undefined leaves the model's default. */
function thinkValueFor(model, level) {
  const levels = reasoningLevelsOf(model);
  if (!levels.includes(level)) return undefined;
  if (levels === THINK_LEVELS) return level;
  return level !== 'none';
}

/**
 * A user turn's images, as Ollama takes them: plain base64 in the message's
 * `images`, next to its text (#92). The attachment carries no `data:` prefix
 * once main has normalised it; one that slipped through is cut off here, since
 * Ollama does not read a data URL. Ollama decodes all four formats Snotra
 * attaches (PNG, JPEG, GIF, WebP — checked in its source at v0.40.6), so none
 * is filtered out. Whether the model sees the image depends on the model.
 */
function imagesForOllama(m) {
  return imageAttachmentsOf(m).map((image) => image.dataBase64.replace(/^data:[^,]*,/, ''));
}

function translateMessagesToOllama(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' });
      continue;
    }
    if (m.role === 'user') {
      const row = { role: 'user', content: typeof m.content === 'string' ? m.content : '' };
      const images = imagesForOllama(m);
      if (images.length > 0) row.images = images;
      out.push(row);
      continue;
    }
    if (m.role === 'assistant') {
      const row = {
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
      };
      // Within a tool loop the model reads its own reasoning back; Ollama
      // takes it in `thinking` (#994).
      if (typeof m.ollamaThinking === 'string' && m.ollamaThinking) row.thinking = m.ollamaThinking;
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
  const level = typeof config?.reasoningEffort === 'string' ? config.reasoningEffort.trim() : '';
  const think = thinkValueFor(model, level);
  if (think !== undefined) body.think = think;

  const headers = { 'Content-Type': 'application/json' };
  let res;
  // A model recognised by its name may still not think — a fine-tune, an
  // import under a known name. Ollama refuses `think` for it; the round then
  // goes out once more without, as it did before #994.
  for (;;) {
    try {
      res = await fetchVia(url, {
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
      return { error: describeFetchErrorMessage(err, base), code: 'NETWORK' };
    }
    if (res.ok) break;
    const error = await readErrorMessage(res);
    if ('think' in body && /does not support thinking/i.test(error)) {
      delete body.think;
      continue;
    }
    return { error, code: String(res.status) };
  }
  if (!res.body) return { error: createMessage('provider.error.noStream'), code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);
  let textOut = '';
  let thinkingOut = '';
  const collectedToolCalls = [];
  // A round ends with `done: true`; a stream without it was cut off on the
  // way (#538).
  let finishReason = FINISH_REASONS.INCOMPLETE;
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
        if (typeof msg.thinking === 'string' && msg.thinking.length > 0) {
          thinkingOut += msg.thinking;
          callbacks.onReasoningDelta?.(msg.thinking);
        }
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
        finishReason = finishReasonOf({
          cutOff: payload.done_reason === 'length' ? FINISH_REASONS.LENGTH : null,
          toolCalls: collectedToolCalls.length > 0,
        });
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
    ...(thinkingOut ? { ollamaThinking: thinkingOut } : {}),
  };
  return { message, finishReason, usage };
}

module.exports = {
  id: 'ollama',
  // The name carries a word — "local" — and is therefore a key (#310).
  name: createMessage('provider.name.ollama'),
  fields: { baseUrl: true, insecureTls: true },
  // translateMessagesToOllama maps image attachments (#92).
  capabilities: { images: true },
  defaultModel: 'llama3.2',
  // Levels for gpt-oss, off and on for the other thinking models (#994).
  reasoning: {
    levels: reasoningLevelsOf,
    defaultLevel: (model) => (reasoningLevelsOf(model) === THINK_SWITCH ? 'on' : 'medium'),
    appliesTo: (model) => reasoningLevelsOf(model).length > 0,
  },
  defaultBaseUrl: DEFAULT_BASE,
  defaultInsecureTls: false,
  apiBase: DEFAULT_BASE,
  presentation: {
    baseUrlPlaceholder: 'http://localhost:11434',
    connectionDetail: true,
  },
  listModels,
  streamChatRound,
  translateMessagesToOllama,
  translateToolsToOllama,
  thinkValueFor,
  destroyInsecureDispatcher,
  dispose: destroyInsecureDispatcher,
};
