const { withRequestTimeout, userMessageOf, LOCAL_MODELS_TIMEOUT_MS } = require('../services/request-timeout');
const { createMessage } = require('../../shared/contracts/message');
const { listChatModels, streamChatCompletionsRound } = require('./openai-chat-transport');

const DEFAULT_BASE = 'http://127.0.0.1:8080/v1';

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
  return listChatModels({
    baseUrl: baseUrlOf(config),
    signal: config.signal,
    serverName: 'MLX-LM',
  });
}

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal }) {
  return streamChatCompletionsRound({
    baseUrl: baseUrlOf(config),
    headers: { 'Content-Type': 'application/json' },
    model,
    messages,
    tools,
    callbacks,
    abortSignal,
    callIdPrefix: 'mlx_call_',
  });
}

module.exports = {
  id: 'mlx-lm',
  name: createMessage('provider.name.mlxLm'),
  fields: { baseUrl: true },
  // Der Server nimmt keine Bilder an — bleibt false (Issue #93).
  capabilities: { images: false },
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
