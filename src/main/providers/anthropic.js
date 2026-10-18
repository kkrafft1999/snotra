const { withRequestTimeout, userMessageOf, CLOUD_MODELS_TIMEOUT_MS } = require('../services/request-timeout');
const { createMessage } = require('../../shared/contracts/message');
const { imageAttachmentsOf } = require('../../shared/contracts/attachments');
const { FINISH_REASONS, finishReasonOf } = require('../../shared/contracts/finish-reason');
const { iterSseEvents, describeFetchErrorMessage, readErrorMessage, abortIfRequested, cancelledChatRound, isAbortError, bindAbortSignalToReader, createEmptyUsage, normalizeUsage, notifyToolCallStart, notifyToolCallArgumentsDelta } = require('./stream-helpers');

const API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

/*
 * Reasoning levels (#994). Claude models think in one of two ways:
 *
 * - Adaptive thinking (Opus 4.6 and newer, Sonnet 4.6 and newer, Haiku 5 and
 *   newer, Fable, Mythos): `thinking: { type: 'adaptive' }` plus
 *   `output_config.effort`. Opus and Sonnet 4.6 know four efforts, the later
 *   models five — `xhigh` came with Opus 4.7.
 * - A thinking budget (Claude 3.7 Sonnet, the 4.0–4.5 models):
 *   `thinking: { type: 'enabled', budget_tokens }`, which has to stay below
 *   `max_tokens` and at 1,024 or more. Three levels map onto three budgets.
 *
 * Older models do not think and get no level.
 */
const ADAPTIVE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ADAPTIVE_EFFORTS_4_6 = ['low', 'medium', 'high', 'max'];
const BUDGET_LEVELS = ['low', 'medium', 'high'];
const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 16384 };
// Thinking counts against `max_tokens`. The room for the answer stays at the
// default; the higher efforts get more, so that a long think does not cut the
// answer off. Anthropic's output rate limit is estimated from `max_tokens`,
// which is why it does not simply go to the model's maximum.
const ADAPTIVE_MAX_TOKENS = { low: 16384, medium: 16384, high: 32768, xhigh: 32768, max: 32768 };

/**
 * Family and version of a Claude model id: `claude-opus-4-6`,
 * `claude-sonnet-4-20250514`, `claude-3-7-sonnet-latest`. A date suffix is no
 * minor version.
 */
function claudeModelOf(model) {
  const id = String(model ?? '').trim().toLowerCase();
  let m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (m) return { family: m[1], version: Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0) };
  m = /^claude-(\d+)(?:-(\d{1,2})(?!\d))?-(opus|sonnet|haiku)/.exec(id);
  if (m) return { family: m[3], version: Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) };
  return null;
}

/** How `model` thinks: 'adaptive', 'adaptive-4.6', 'budget' or null. */
function thinkingModeOf(model) {
  const claude = claudeModelOf(model);
  if (!claude) return null;
  const { family, version } = claude;
  if (family === 'fable' || family === 'mythos') return 'adaptive';
  if (family === 'opus') {
    if (version >= 4.7) return 'adaptive';
    if (version >= 4.6) return 'adaptive-4.6';
    return version >= 4 ? 'budget' : null;
  }
  if (family === 'sonnet') {
    if (version >= 5) return 'adaptive';
    if (version >= 4.6) return 'adaptive-4.6';
    return version >= 3.7 ? 'budget' : null;
  }
  if (family === 'haiku') {
    if (version >= 5) return 'adaptive';
    return version >= 4.5 ? 'budget' : null;
  }
  return null;
}

function reasoningLevelsOf(model) {
  const mode = thinkingModeOf(model);
  if (mode === 'adaptive') return ADAPTIVE_EFFORTS;
  if (mode === 'adaptive-4.6') return ADAPTIVE_EFFORTS_4_6;
  if (mode === 'budget') return BUDGET_LEVELS;
  return [];
}

/**
 * The request fields for a level. Adaptive models are asked for summarised
 * thinking: from Opus 4.7 on the default is `omitted`, which streams thinking
 * blocks without text and leaves a long silence before the answer. The 4.6
 * models summarise by default.
 */
function thinkingFieldsFor(model, level) {
  const mode = thinkingModeOf(model);
  if (!mode || !reasoningLevelsOf(model).includes(level)) return {};
  if (mode === 'budget') {
    const budget = THINKING_BUDGETS[level];
    return {
      thinking: { type: 'enabled', budget_tokens: budget },
      max_tokens: budget + DEFAULT_MAX_TOKENS,
    };
  }
  return {
    thinking: mode === 'adaptive' ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' },
    output_config: { effort: level },
    max_tokens: ADAPTIVE_MAX_TOKENS[level] || DEFAULT_MAX_TOKENS,
  };
}

function authHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
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
    res = await fetch(`${API_BASE}/models?limit=100`, { headers: authHeaders(apiKey), signal: config.signal });
  } catch (err) {
    return { error: describeFetchErrorMessage(err, API_BASE) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.data)) {
    return { error: createMessage('provider.error.unexpectedAnswer.api', { provider: 'Anthropic' }) };
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

/** Anthropic's stop reasons that mean "cut off" (#538). */
function cutOffOf(stopReason) {
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') return FINISH_REASONS.LENGTH;
  if (stopReason === 'refusal') return FINISH_REASONS.CONTENT_FILTER;
  return null;
}

function isLikelyJsonString(s) {
  const t = String(s ?? '').trim();
  return t.length > 0 && (t[0] === '{' || t[0] === '[' || t === 'null' || t === 'true' || t === 'false' || /^-?\d/.test(t));
}

/**
 * The turn that is still running: the messages after the last user message.
 * Its thinking blocks go back with it — a tool loop with thinking on expects
 * the reasoning that led to a call in front of the call. Earlier turns go
 * without theirs, as they always have: Anthropic would drop them anyway, and
 * a history that never carries them never changes under them.
 */
function currentTurnStart(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i + 1;
  }
  return 0;
}

/** The thinking blocks a message carries for `model`; none from another model. */
function thinkingBlocksFor(message, model) {
  const thinking = message?.anthropicThinking;
  if (!thinking || !Array.isArray(thinking.blocks) || !model || thinking.model !== model) return [];
  return thinking.blocks.filter((b) => (b?.type === 'thinking' && typeof b.signature === 'string')
    || (b?.type === 'redacted_thinking' && typeof b.data === 'string'));
}

function translateMessagesToAnthropic(messages, { model, replayThinking = true } = {}) {
  const turnStart = replayThinking ? currentTurnStart(messages) : messages.length;
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

  for (const [index, m] of messages.entries()) {
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
      const text = typeof m.content === 'string' ? m.content : '';
      // imageAttachmentsOf keeps png, jpeg, gif and webp — the formats
      // Anthropic takes; anything else never reaches the request (#90).
      const images = imageAttachmentsOf(m);
      if (images.length === 0) {
        out.push({ role: 'user', content: text });
        continue;
      }
      // Images go in front of the question, as Anthropic recommends. An empty
      // text block is refused by the API, and a screenshot without a question
      // is a valid input.
      const content = images.map((image) => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType.toLowerCase(), data: image.dataBase64 },
      }));
      if (text) content.push({ type: 'text', text });
      out.push({ role: 'user', content });
      continue;
    }
    if (m.role === 'assistant') {
      // Thinking comes first, unchanged — the API checks the signature.
      const blocks = index >= turnStart ? thinkingBlocksFor(m, model).map((b) => ({ ...b })) : [];
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
      // A turn stopped before its first token has nothing to say, and the API
      // refuses an empty text block — for this and every later message of the
      // chat (#540). Two user turns in a row are merged by the API.
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }
  }
  flushPendingToolResults();
  return { system: system || undefined, messages: out };
}

/** The round's thinking blocks as the API wants them back: unchanged, in order. */
function collectThinkingBlocks(blocks, orderedIndexes) {
  const out = [];
  for (const idx of orderedIndexes) {
    const b = blocks.get(idx);
    if (b?.type === 'thinking' && b.signature) {
      out.push({ type: 'thinking', thinking: b.text || '', signature: b.signature });
    } else if (b?.type === 'redacted_thinking' && b.data) {
      out.push({ type: 'redacted_thinking', data: b.data });
    }
  }
  return out;
}

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal }) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: createMessage('provider.error.noApiKey'), code: 'NO_API_KEY' };

  const tooling = translateToolsToAnthropic(tools);
  const level = typeof config?.reasoningEffort === 'string' ? config.reasoningEffort.trim() : '';
  const thinkingFields = thinkingFieldsFor(model, level);
  function buildBody(replayThinking) {
    const { system, messages: anthMessages } = translateMessagesToAnthropic(messages, { model, replayThinking });
    const body = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
      messages: anthMessages,
      ...thinkingFields,
    };
    if (system) body.system = system;
    if (tooling) body.tools = tooling;
    return body;
  }

  const url = `${API_BASE}/messages`;
  const headers = authHeaders(apiKey);

  let res;
  // Newer models bind a thinking block to the conversation before it. When
  // the history of the running turn changed since — the chat engine shortens
  // old tool outputs when the context runs full — the API refuses the block.
  // The documented way out is to send the turn once more without its
  // thinking; the model then goes on without that reasoning.
  for (const replayThinking of [true, false]) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildBody(replayThinking)),
        signal: abortSignal,
      });
    } catch (err) {
      if (isAbortError(err)) return cancelledChatRound({ role: 'assistant', content: '' });
      return { error: describeFetchErrorMessage(err, API_BASE), code: 'NETWORK' };
    }
    if (res.ok) break;
    const error = await readErrorMessage(res);
    if (replayThinking && res.status === 400 && /bound to a different conversation/i.test(error)) continue;
    return { error, code: String(res.status) };
  }
  if (!res.body) return { error: createMessage('provider.error.noStream'), code: 'STREAM' };

  const reader = res.body.getReader();
  const unbindAbort = bindAbortSignalToReader(reader, abortSignal);

  // Accumulators per content block index
  const blocks = new Map(); // index -> { type, text?, toolCall: {id, name, args} }
  let textOut = '';
  let stopReason = null;
  // `message_stop` (or at least a stop reason) closes a round; without it the
  // stream was cut off on the way (#538).
  let messageStopped = false;
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
          usage = usage || createEmptyUsage();
          usage.prompt = startUsage.prompt;
          usage.completion = startUsage.completion;
          // Anthropic nennt die Cache-Anteile nur hier, im `message_start`;
          // das `message_delta` am Ende wiederholt sie nicht (Issue #179).
          usage.cached = startUsage.cached;
          if (startUsage.cacheWrite) usage.cacheWrite = startUsage.cacheWrite;
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
          notifyToolCallStart(callbacks, { index: idx, name: cb.name || '' });
        } else if (cb.type === 'thinking') {
          blocks.set(idx, { type: 'thinking', text: cb.thinking || '', signature: cb.signature || '' });
        } else if (cb.type === 'redacted_thinking') {
          blocks.set(idx, { type: 'redacted_thinking', data: cb.data || '' });
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
            notifyToolCallArgumentsDelta(callbacks, { index: idx, delta: d.partial_json });
          }
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          block.text = (block.text || '') + d.thinking;
          callbacks.onReasoningDelta?.(d.thinking);
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          block.signature = (block.signature || '') + d.signature;
        }
      } else if (type === 'content_block_stop') {
        // no-op; data already accumulated
      } else if (type === 'message_delta') {
        const deltaUsage = normalizeUsage(payload.usage);
        if (deltaUsage) {
          usage = usage || createEmptyUsage();
          if (deltaUsage.completion > 0) usage.completion = deltaUsage.completion;
          if (deltaUsage.prompt > 0) usage.prompt = deltaUsage.prompt;
          if (deltaUsage.cached > 0) usage.cached = deltaUsage.cached;
          if (deltaUsage.cacheWrite > 0) usage.cacheWrite = deltaUsage.cacheWrite;
          usage.total = usage.prompt + usage.completion;
        }
        const sr = payload.delta?.stop_reason;
        if (sr) stopReason = sr;
      } else if (type === 'message_stop') {
        messageStopped = true;
      } else if (type === 'error') {
        const msg = payload.error?.message || createMessage('provider.error.streamFailed');
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

  const thinkingBlocks = collectThinkingBlocks(blocks, orderedIndexes);
  const message = {
    role: 'assistant',
    content: textOut.length > 0 ? textOut : tool_calls.length ? null : '',
    ...(tool_calls.length ? { tool_calls } : {}),
    // Goes back with the next round of this turn (translateMessagesToAnthropic).
    ...(thinkingBlocks.length ? { anthropicThinking: { model, blocks: thinkingBlocks } } : {}),
  };

  const finishReason = stopReason || messageStopped
    ? finishReasonOf({ cutOff: cutOffOf(stopReason), toolCalls: tool_calls.length > 0 })
    : FINISH_REASONS.INCOMPLETE;

  return { message, finishReason, usage };
}

module.exports = {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  fields: { apiKey: true },
  // translateMessagesToAnthropic maps image attachments (#90).
  capabilities: { images: true },
  defaultModel: 'claude-sonnet-4-6',
  // The levels depend on how the model thinks (#994); see thinkingModeOf.
  reasoning: {
    levels: reasoningLevelsOf,
    defaultLevel: 'medium',
    appliesTo: (model) => thinkingModeOf(model) !== null,
  },
  apiBase: API_BASE,
  presentation: {
    apiKeyPlaceholder: 'sk-ant-…',
  },
  listModels,
  streamChatRound,
  translateMessagesToAnthropic,
  translateToolsToAnthropic,
  thinkingModeOf,
  thinkingFieldsFor,
};
