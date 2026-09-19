const { withRequestTimeout, CLOUD_MODELS_TIMEOUT_MS } = require('../services/request-timeout');
const { describeFetchError, readErrorMessage } = require('./stream-helpers');
const { streamResponsesRound } = require('./openai-responses-transport');

const DEFAULT_BASE = 'https://api.openai.com/v1';

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
    return { error: err.message };
  }
}

async function listModelsRequest(config) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: 'API-Key fehlt.' };
  const base = baseUrlOf(config);
  let res;
  try {
    res = await fetch(`${base}/models`, {
      signal: config.signal,
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

async function streamChatRound({ config, model, messages, tools, callbacks, abortSignal, cacheKey }) {
  const apiKey = config?.apiKey;
  if (!apiKey) return { error: 'Kein API-Key hinterlegt.', code: 'NO_API_KEY' };

  const extraBody = {};
  // Prompt-Caching greift ab ~1.024 Token automatisch, aber nur, wenn die
  // Anfrage auf derselben Maschine landet wie die vorige. Der Schluessel (die
  // Chat-ID) sorgt dafuer, dass die Runden eines Chats zuverlaessig denselben
  // Cache treffen — spuerbar in der Tool-Schleife, wo dieselben Schemas bis zu
  // 40-mal hinausgehen (Issue #179).
  if (typeof cacheKey === 'string' && cacheKey.trim()) {
    extraBody.prompt_cache_key = cacheKey.trim();
  }
  if (typeof config?.reasoningEffort === 'string' && config.reasoningEffort.trim()) {
    extraBody.reasoning = { effort: config.reasoningEffort.trim() };
  }
  // Zusammenfassung des Nachdenkens mitstreamen (Issue #87): macht Minuten
  // lange Denkpausen als Zwischenschritte sichtbar. Standard aus, weil OpenAI
  // dafür je nach Organisation eine Verifizierung verlangt.
  if (config?.reasoningSummary === 'auto') {
    extraBody.reasoning = { ...(extraBody.reasoning || {}), summary: 'auto' };
  }

  return streamResponsesRound({
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
