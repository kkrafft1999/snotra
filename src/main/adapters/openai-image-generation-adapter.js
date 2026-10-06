'use strict';

/**
 * Image generation through OpenAI's Images API (#85).
 *
 * The key is the one the OpenAI provider already holds, the same way voice
 * input borrows it: whoever chats with OpenAI can draw with it, and nobody has
 * to store a second key. Everything OpenAI-specific stays in this file; another
 * service means another adapter, not another tool.
 *
 * What the API does that the adapter has to know about:
 * - The `gpt-image-*` models answer with base64 only, never with a URL — so
 *   nothing has to be downloaded afterwards, and nothing remote ever reaches
 *   the renderer.
 * - A large image takes tens of seconds, sometimes more than a minute; the
 *   timeout is generous accordingly.
 * - Every successful call is billed. A 429 or 503 is retried, because the
 *   service said no before it drew anything. A call whose outcome is unknown
 *   — a timeout, a dropped connection — is not: it may already have been
 *   paid for.
 */

const { withRequestTimeout, userMessageOf, CLOUD_MODELS_TIMEOUT_MS } = require('../services/request-timeout');
const { createMessage } = require('../../shared/contracts/message');
const { sniffImageMime } = require('../../shared/contracts/workspace-image');
const { normalizeImageModel } = require('../../shared/contracts/settings');
const { readErrorMessage } = require('../providers/stream-helpers');
const { describeFetchErrorMessage } = require('../../shared/runtime/fetch-errors');
const {
  IMAGE_GENERATION_ERROR_CODES: CODES,
  IMAGE_SIZES,
  IMAGE_QUALITIES,
  IMAGE_FORMATS,
  IMAGE_BACKGROUNDS,
  IMAGE_MIME_BY_FORMAT,
  IMAGE_GENERATION_LIMITS: LIMITS,
} = require('../../application/ports/image-generation-port');

const OPENAI_API_BASE = 'https://api.openai.com/v1';

/**
 * The model a fresh installation draws with: OpenAI's fast everyday model as
 * of 2026-10. The settings list what the key can reach, so a newer model is a
 * choice there, not a release here.
 */
const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5-flare';


const GENERATION_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [2_000, 5_000];
const MAX_RETRY_AFTER_MS = 20_000;

/** A model id the Images API takes: `gpt-image-…` or `chatgpt-image-…`. */
function isImageModel(model) {
  return normalizeImageModel(model) !== '';
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Waits, unless the call is cancelled first. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryDelay(response, attempt) {
  // `Number(null)` is 0: without the header the backoff applies, not no wait.
  const raw = response?.headers?.get?.('retry-after');
  const header = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, MAX_RETRY_AFTER_MS);
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

async function readErrorBody(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return { message: '', code: '' };
  }
  try {
    const json = JSON.parse(text);
    const error = json?.error && typeof json.error === 'object' ? json.error : {};
    return {
      message: typeof error.message === 'string' ? error.message.trim() : '',
      code: typeof error.code === 'string' ? error.code : (typeof error.type === 'string' ? error.type : ''),
    };
  } catch {
    return { message: text.trim().slice(0, 300), code: '' };
  }
}

/** A quota that is used up is not a rate limit: waiting does not help. */
function isRetryable(status, code) {
  if (status === 503) return true;
  return status === 429 && code !== 'insufficient_quota';
}

function errorFor(status, { message, code }) {
  const detail = message ? ` (${message.slice(0, 300)})` : '';
  if (status === 401 || status === 403) {
    return {
      code: CODES.UNAUTHORIZED,
      error: `OpenAI rejected the key or the model${detail}. Ask the user to check the OpenAI key and the image model under "{menu:settings.tools}".`,
    };
  }
  if (/moderation|content_policy|safety/i.test(code)) {
    return {
      code: CODES.REFUSED,
      error: `OpenAI refused to draw this prompt${detail}. Do not retry the same prompt; tell the user, or change what is asked for.`,
    };
  }
  if (status === 429 && code === 'insufficient_quota') {
    return {
      code: CODES.RATE_LIMITED,
      error: `The OpenAI quota is used up${detail}. Tell the user; retrying will not help.`,
    };
  }
  if (status === 429) {
    return { code: CODES.RATE_LIMITED, error: `OpenAI is rate limiting image requests${detail}. Try again later.` };
  }
  if (status === 400 || status === 404) {
    return { code: CODES.INVALID_REQUEST, error: `OpenAI did not accept the request${detail}.` };
  }
  return { code: CODES.SERVICE, error: `The image could not be generated: HTTP ${status}${detail}.` };
}

/**
 * @param {Object} deps
 * @param {() => Promise<string|null>} deps.readApiKey  the decrypted OpenAI key
 * @param {() => boolean} deps.hasApiKey  synchronous state for the tool's visibility
 * @param {() => string} [deps.getModel]  the model chosen in the settings
 * @param {typeof fetch} [deps.fetchImpl]  looked up per call by default, like the providers do
 * @param {string} [deps.baseUrl]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.wait]  injectable for tests
 * @param {number} [deps.timeoutMs]
 */
function createOpenAiImageGenerationAdapter({
  readApiKey,
  hasApiKey,
  getModel = () => DEFAULT_IMAGE_MODEL,
  fetchImpl = (...args) => globalThis.fetch(...args),
  baseUrl = OPENAI_API_BASE,
  wait = sleep,
  timeoutMs = GENERATION_TIMEOUT_MS,
}) {
  function currentModel() {
    const chosen = getModel();
    return isImageModel(chosen) ? chosen.trim() : DEFAULT_IMAGE_MODEL;
  }

  async function requestOnce(body, apiKey, abortSignal) {
    return withRequestTimeout(
      async (signal) => {
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!response?.ok) {
          return { response, error: await readErrorBody(response) };
        }
        // Read inside the timeout: the body is where the image is.
        return { response, payload: await response.json() };
      },
      { timeoutMs, signal: abortSignal },
    );
  }

  return {
    isConfigured() {
      return hasApiKey() === true;
    },

    getModel: currentModel,

    /**
     * The image models the key can reach, for the choice in the settings.
     * Errors travel as message keys for the settings dialog, like the model
     * listing of the providers (#308).
     */
    async listModels({ signal } = {}) {
      const apiKey = await readApiKey();
      if (!apiKey) return { error: createMessage('settings.imageGeneration.error.noKey') };
      const base = baseUrl.replace(/\/$/, '');
      try {
        return await withRequestTimeout(
          async (requestSignal) => {
            let response;
            try {
              response = await fetchImpl(`${base}/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: requestSignal,
              });
            } catch (err) {
              return { error: describeFetchErrorMessage(err, base) };
            }
            if (!response?.ok) return { error: await readErrorMessage(response) };
            const json = await response.json().catch(() => null);
            if (!json || !Array.isArray(json.data)) {
              return { error: createMessage('provider.error.unexpectedAnswer.api', { provider: 'OpenAI' }) };
            }
            const models = [...new Set(json.data.map((entry) => entry?.id).filter(isImageModel))]
              .sort((a, b) => a.localeCompare(b));
            return { models };
          },
          { timeoutMs: CLOUD_MODELS_TIMEOUT_MS, signal },
        );
      } catch (err) {
        return { error: userMessageOf(err) };
      }
    },

    async generate({ prompt, size, quality, format, background, abortSignal } = {}) {
      const text = typeof prompt === 'string' ? prompt.trim() : '';
      if (!text) {
        return { ok: false, code: CODES.INVALID_REQUEST, error: 'No prompt was handed over.' };
      }
      if (text.length > LIMITS.MAX_PROMPT_CHARS) {
        return {
          ok: false,
          code: CODES.INVALID_REQUEST,
          error: `The prompt is longer than ${LIMITS.MAX_PROMPT_CHARS} characters.`,
        };
      }
      const outputFormat = pick(format, IMAGE_FORMATS, 'png');
      const outputBackground = pick(background, IMAGE_BACKGROUNDS, 'auto');
      if (outputBackground === 'transparent' && outputFormat === 'jpeg') {
        return {
          ok: false,
          code: CODES.INVALID_REQUEST,
          error: 'A transparent background needs a PNG or WebP file, not JPEG.',
        };
      }

      const apiKey = await readApiKey();
      if (!apiKey) {
        return {
          ok: false,
          code: CODES.NO_API_KEY,
          error: 'No OpenAI key is stored. Ask the user to add one under "{menu:settings.models}".',
        };
      }

      const model = currentModel();
      const body = {
        model,
        prompt: text,
        n: 1,
        size: pick(size, IMAGE_SIZES, LIMITS.DEFAULT_SIZE),
        quality: pick(quality, IMAGE_QUALITIES, LIMITS.DEFAULT_QUALITY),
        output_format: outputFormat,
      };
      if (outputBackground !== 'auto') body.background = outputBackground;

      let result;
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await requestOnce(body, apiKey, abortSignal);
        } catch (err) {
          if (abortSignal?.aborted) {
            return { ok: false, code: CODES.ABORTED, error: 'The image request was cancelled.' };
          }
          if (err?.userMessage?.key === 'provider.error.timeout') {
            return {
              ok: false,
              code: CODES.TIMEOUT,
              error: `OpenAI did not answer within ${timeoutMs / 1000} s. The image may still have been billed; do not retry on your own, ask the user first.`,
            };
          }
          return {
            ok: false,
            code: CODES.NETWORK,
            error: `OpenAI could not be reached: ${err?.message || 'network error'}. The request may or may not have arrived; ask the user before retrying.`,
          };
        }
        if (!result.error) break;
        const status = result.response?.status ?? 0;
        if (attempt >= MAX_RETRIES || !isRetryable(status, result.error.code)) {
          return { ok: false, ...errorFor(status, result.error) };
        }
        try {
          await wait(retryDelay(result.response, attempt), abortSignal);
        } catch {
          return { ok: false, code: CODES.ABORTED, error: 'The image request was cancelled.' };
        }
      }

      const item = Array.isArray(result.payload?.data) ? result.payload.data[0] : null;
      const b64 = typeof item?.b64_json === 'string' ? item.b64_json : '';
      if (!b64) {
        return {
          ok: false,
          code: CODES.REFUSED,
          error: 'OpenAI answered without an image. The prompt may have been refused; tell the user.',
        };
      }
      if (b64.length * 0.75 > LIMITS.MAX_IMAGE_BYTES) {
        return { ok: false, code: CODES.SERVICE, error: 'The image OpenAI returned is too large to be saved.' };
      }
      const bytes = Buffer.from(b64, 'base64');
      const expected = IMAGE_MIME_BY_FORMAT[outputFormat];
      const mime = sniffImageMime(bytes.subarray(0, 64));
      if (mime !== expected) {
        return {
          ok: false,
          code: CODES.SERVICE,
          error: `OpenAI returned something that is not a ${outputFormat.toUpperCase()} image.`,
        };
      }
      const out = { ok: true, bytes, mime, model };
      const revised = typeof item.revised_prompt === 'string' ? item.revised_prompt.trim() : '';
      if (revised && revised !== text) out.revisedPrompt = revised.slice(0, LIMITS.MAX_PROMPT_CHARS);
      return out;
    },
  };
}

module.exports = {
  createOpenAiImageGenerationAdapter,
  DEFAULT_IMAGE_MODEL,
  OPENAI_API_BASE,
  isImageModel,
};
