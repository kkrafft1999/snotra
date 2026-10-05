const { withRequestTimeout, userMessageOf, CLOUD_MODELS_TIMEOUT_MS } = require('../services/request-timeout');
const { createMessage } = require('../../shared/contracts/message');
const { describeFetchErrorMessage, readErrorMessage } = require('./stream-helpers');
const { streamResponsesRound } = require('./openai-responses-transport');

const DEFAULT_BASE = 'https://api.openai.com/v1';
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function baseUrlOf(config) {
  const raw = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  return (raw || DEFAULT_BASE).replace(/\/$/, '');
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
  const base = baseUrlOf(config);
  let res;
  try {
    res = await fetch(`${base}/models`, {
      signal: config.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return { error: describeFetchErrorMessage(err, base) };
  }
  if (!res.ok) return { error: await readErrorMessage(res) };
  const json = await res.json().catch(() => null);
  if (!json || !Array.isArray(json.data)) {
    return { error: createMessage('provider.error.unexpectedAnswer.api', { provider: 'OpenAI' }) };
  }
  const models = json.data
    .map((m) => m && typeof m.id === 'string' ? { id: m.id, label: m.id } : null)
    .filter(Boolean)
    .filter((m) => !/whisper|tts|embedding|dall-e|moderation|davinci|babbage|curie|^ada/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal, cacheKey }) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: createMessage('provider.error.noApiKey'), code: 'NO_API_KEY' };

  const extraBody = {};
  // Prompt-Caching greift ab ~1.024 Token automatisch, aber nur, wenn die
  // Anfrage auf derselben Maschine landet wie die vorige. Der Schluessel (die
  // Chat-ID) sorgt dafuer, dass die Runden eines Chats zuverlaessig denselben
  // Cache treffen — spuerbar in der Tool-Schleife, wo dieselben Schemas bis zu
  // 40-mal hinausgehen (Issue #179).
  if (typeof cacheKey === 'string' && cacheKey.trim()) {
    extraBody.prompt_cache_key = cacheKey.trim();
  }
  const effort = typeof config?.reasoningEffort === 'string' ? config.reasoningEffort.trim() : '';
  if (effort) extraBody.reasoning = { effort };
  // Zusammenfassung des Nachdenkens mitstreamen (Issue #87): macht Minuten
  // lange Denkpausen als Zwischenschritte sichtbar. Standard aus, weil OpenAI
  // dafür je nach Organisation eine Verifizierung verlangt.
  if (config?.reasoningSummary === 'auto') {
    extraBody.reasoning = { ...(extraBody.reasoning || {}), summary: 'auto' };
  }

  const result = await streamResponsesRound({
    baseUrl: baseUrlOf(config),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    model,
    messages,
    tools,
    callbacks,
    abortSignal,
    extraBody,
  });
  return withEffortRejectionExplained(result, model, effort);
}

/**
 * OpenAI knows seven reasoning levels, but every model only a few of them, and
 * a level the model lacks comes back as HTTP 400 (#718). That answer is put
 * into the app's own words — model, level, and the levels OpenAI lists as
 * possible — with the way to change it. A model that takes no level at all is
 * left to OpenAI's text: no other level would help there.
 */
function withEffortRejectionExplained(result, model, effort) {
  if (!effort || result?.code !== '400' || typeof result.error !== 'string') return result;
  const text = result.error;
  const aboutEffort = result.param === 'reasoning.effort' || /reasoning\.effort/.test(text);
  if (!aboutEffort || /unsupported parameter/i.test(text)) return result;
  const listed = /supported values are:?([^.]*)/i.exec(text)?.[1] || '';
  const supported = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return {
    ...result,
    error: supported.length > 0
      ? createMessage('provider.openai.error.effortUnsupported.withList', {
        model, effort, supported: supported.join(', '),
      })
      : createMessage('provider.openai.error.effortUnsupported', { model, effort }),
  };
}

module.exports = {
  id: 'openai',
  name: 'OpenAI',
  fields: { apiKey: true },
  // Sagt, ob *dieser Adapter* Bilder weiterreicht — nicht, ob das gewaehlte
  // Modell sie versteht (Issue #93).
  capabilities: { images: true },
  defaultModel: 'gpt-4o-mini',
  apiBase: DEFAULT_BASE,
  presentation: {
    apiKeyPlaceholder: 'sk-…',
    presetFields: [
      {
        key: 'reasoningEffort',
        type: 'select',
        control: 'segmented',
        label: 'Reasoning',
        hint: createMessage('provider.openai.reasoning.hint'),
        defaultValue: 'medium',
        affectsPresetIdentity: true,
        detailStyle: 'mono',
        // Ohne Praefix: Der nackte Wert steht im Chat hinter dem Modellnamen
        // („OpenAI · gpt-5 · high“), der API-Parametername gehoert in den Hint.
        detailPrefix: '',
        showAsSuffix: true,
        // All the levels OpenAI knows (#718). Which of them a model takes is
        // not in `/v1/models`, and a table of our own would be out of date
        // with the next release — so all seven are offered, and a rejected
        // one is explained in the chat (withEffortRejectionExplained).
        options: REASONING_EFFORTS.map((value) => ({ value, label: value })),
        formatDetail: (value) => `${value}`,
      },
      {
        key: 'reasoningSummary',
        type: 'select',
        // Off and on: the first option is the switch's off position (#414).
        control: 'switch',
        label: createMessage('provider.openai.reasoningSummary.label'),
        toggleLabel: createMessage('provider.openai.reasoningSummary.toggle'),
        hint: createMessage('provider.openai.reasoningSummary.hint'),
        defaultValue: 'off',
        affectsPresetIdentity: false,
        detailStyle: 'mono',
        options: [
          { value: 'off', label: createMessage('provider.openai.reasoningSummary.off') },
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
