/** @typedef {import('../ports/provider-runtime-port').ProviderAdapter} ProviderAdapter */
/** @typedef {import('../ports/provider-runtime-port').ProviderConfig} ProviderConfig */
/** @typedef {import('../ports/provider-runtime-port').ChatRoundResult} ChatRoundResult */

const { withRequestTimeout, userMessageOf, CLOUD_MODELS_TIMEOUT_MS } = require('../services/request-timeout');
const { createMessage } = require('../../shared/contracts/message');
const { isRecord } = require('../../shared/runtime/is-record');
const { describeFetchErrorMessage, readErrorMessage } = require('./stream-helpers');
const { streamResponsesRound } = require('./openai-responses-transport');

const DEFAULT_BASE = 'https://api.openai.com/v1';
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The models Snotra offers: GPT-5 and newer (#724), fine-tuned ones included,
 * but not the `-chat` snapshots, which take no reasoning level. The same rule
 * decides whether a request carries `reasoning` — an entry with an older model
 * keeps working, it just gets no level it would reject (#720). The settings
 * read the rule through `presentation.offeredModels`, matched without case.
 */
const OFFERED_MODELS = /^(?:ft:)?gpt-(?:[5-9]|[1-9]\d+)(?!\d)(?!.*-chat(?:-|$))/i;
// GPT-5 and newer also come as variants that do not chat.
const NOT_FOR_CHAT = /realtime|audio|transcribe|tts|image|search|embedding/i;

/** @param {unknown} model */
function isOfferedModel(model) {
  return OFFERED_MODELS.test(String(model ?? '').trim());
}

/** @param {ProviderConfig|null|undefined} config */
function baseUrlOf(config) {
  const raw = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  return (raw || DEFAULT_BASE).replace(/\/$/, '');
}

/** @type {ProviderAdapter['listModels']} */
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

/** @type {ProviderAdapter['listModels']} */
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
  if (!isRecord(json) || !Array.isArray(json.data)) {
    return { error: createMessage('provider.error.unexpectedAnswer.api', { provider: 'OpenAI' }) };
  }
  const models = json.data
    .map((/** @type {unknown} */ m) => isRecord(m) && typeof m.id === 'string' ? { id: m.id, label: m.id } : null)
    .filter((m) => m !== null)
    .filter((m) => isOfferedModel(m.id) && !NOT_FOR_CHAT.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models };
}

/** @type {ProviderAdapter['streamChatRound']} */
async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal, cacheKey }) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: createMessage('provider.error.noApiKey'), code: 'NO_API_KEY' };

  /** @type {{ prompt_cache_key?: string, reasoning?: { effort?: string, summary?: string } }} */
  const extraBody = {};
  // Prompt-Caching greift ab ~1.024 Token automatisch, aber nur, wenn die
  // Anfrage auf derselben Maschine landet wie die vorige. Der Schluessel (die
  // Chat-ID) sorgt dafuer, dass die Runden eines Chats zuverlaessig denselben
  // Cache treffen — spuerbar in der Tool-Schleife, wo dieselben Schemas bis zu
  // 40-mal hinausgehen (Issue #179).
  if (typeof cacheKey === 'string' && cacheKey.trim()) {
    extraBody.prompt_cache_key = cacheKey.trim();
  }
  // An older model gets no `reasoning` at all (#724): it would turn the
  // parameter down, whatever its value.
  const takesReasoning = isOfferedModel(model);
  const effort = takesReasoning && typeof config?.reasoningEffort === 'string'
    ? config.reasoningEffort.trim()
    : '';
  if (effort) extraBody.reasoning = { effort };
  // Zusammenfassung des Nachdenkens mitstreamen (Issue #87): macht Minuten
  // lange Denkpausen als Zwischenschritte sichtbar. Standard aus, weil OpenAI
  // dafür je nach Organisation eine Verifizierung verlangt.
  if (takesReasoning && config?.reasoningSummary === 'auto') {
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
 *
 * @param {ChatRoundResult} result
 * @param {string} model
 * @param {string} effort
 * @returns {ChatRoundResult}
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

/** @type {ProviderAdapter} */
module.exports = {
  id: 'openai',
  name: 'OpenAI',
  fields: { apiKey: true },
  // What *this adapter* passes on — not whether the chosen model understands
  // it (#93). The vocabulary is in shared/contracts/provider-capabilities.js.
  capabilities: {
    images: { supported: true },
    reasoningLevels: { supported: true },
  },
  traits: {
    // Measured against o200k (context-breakdown.js, #178).
    tokenizerProfile: 'o200k',
    priceTable: { litellmProviders: ['openai'] },
  },
  defaultModel: 'gpt-5-mini',
  // The levels a chat can choose (#725): all seven, for the models Snotra
  // offers. Which of them a model really takes is not in `/v1/models`; a
  // rejected one is explained in the chat (withEffortRejectionExplained).
  reasoning: {
    levels: REASONING_EFFORTS,
    defaultLevel: 'medium',
    appliesTo: isOfferedModel,
  },
  apiBase: DEFAULT_BASE,
  presentation: {
    apiKeyPlaceholder: 'sk-…',
    offeredModels: OFFERED_MODELS.source,
    offeredModelsHint: createMessage('provider.openai.model.noLongerOffered'),
    presetFields: [
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
