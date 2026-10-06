/**
 * Image generation port: an image from a prompt, without the core knowing the
 * service (#85).
 *
 * The concrete provider (OpenAI for now) sits in the adapter. The port is kept
 * narrow on purpose: a prompt and a few hints in, the image bytes out. The
 * adapters differ more than they look — one answers in a single request,
 * another submits and polls, one returns base64, another a part of a larger
 * answer — so `generate` is async throughout and every adapter decodes its
 * own response. Errors come back as a result, not as an exception: a missing
 * key, a refused prompt or a quota is information for the model, not a crash.
 */

/**
 * @typedef {Object} ImageGenerationRequest
 * @property {string} prompt
 * @property {string} [size]      one of IMAGE_SIZES
 * @property {string} [quality]   one of IMAGE_QUALITIES
 * @property {string} [format]    one of IMAGE_FORMATS
 * @property {string} [background] one of IMAGE_BACKGROUNDS
 * @property {AbortSignal} [abortSignal]
 */

/**
 * @typedef {Object} ImageGenerationOk
 * @property {true} ok
 * @property {Buffer} bytes
 * @property {string} mime       image/png, image/jpeg or image/webp
 * @property {string} model      the model that made the image
 * @property {string} [revisedPrompt]  what the service actually drew, if it says
 */

/**
 * @typedef {Object} ImageGenerationError
 * @property {false} ok
 * @property {string} error   plain text for the model and the display
 * @property {string} code    IMAGE_GENERATION_ERROR_CODES value
 */

/**
 * @typedef {Object} ImageGenerationPort
 * @property {() => boolean} isConfigured
 *   Whether a key is there. Synchronous, because the tool's visibility has to
 *   be known while the tool list is built.
 * @property {() => string} getModel  the model the next image is made with
 * @property {(request: ImageGenerationRequest) => Promise<ImageGenerationOk|ImageGenerationError>} generate
 */

/** The kinds of failure the handler has to tell apart. */
const IMAGE_GENERATION_ERROR_CODES = Object.freeze({
  NO_API_KEY: 'NO_API_KEY',
  INVALID_REQUEST: 'INVALID_REQUEST',
  REFUSED: 'REFUSED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  NETWORK: 'NETWORK',
  SERVICE: 'SERVICE',
});

/**
 * The sizes the tool offers. Newer models take any WIDTHxHEIGHT, but three
 * fixed shapes are what every image model of the family understands, and a
 * small, closed list keeps the cost of a call predictable.
 */
const IMAGE_SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536']);

/**
 * Quality levels the tool offers. `xhigh` and `max` exist for the newest
 * models only and cost a multiple; they are left out on purpose.
 */
const IMAGE_QUALITIES = Object.freeze(['low', 'medium', 'high']);

const IMAGE_FORMATS = Object.freeze(['png', 'jpeg', 'webp']);

const IMAGE_BACKGROUNDS = Object.freeze(['auto', 'opaque', 'transparent']);

const IMAGE_MIME_BY_FORMAT = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

/** The file extensions that match a format, the first one preferred. */
const IMAGE_EXTENSIONS_BY_FORMAT = Object.freeze({
  png: Object.freeze(['.png']),
  jpeg: Object.freeze(['.jpg', '.jpeg']),
  webp: Object.freeze(['.webp']),
});

/** Bounds of a call — the model cannot go past them either. */
const IMAGE_GENERATION_LIMITS = Object.freeze({
  MAX_PROMPT_CHARS: 4000,
  DEFAULT_SIZE: '1024x1024',
  DEFAULT_QUALITY: 'medium',
  /**
   * Images per run. An agent will happily loop on "make it a bit bluer", and
   * every call is billed; the cap belongs in the tool, not in the prompt.
   */
  MAX_IMAGES_PER_RUN: 4,
  /** Larger answers are not read: the biggest image of the list is far below. */
  MAX_IMAGE_BYTES: 25 * 1024 * 1024,
});

module.exports = {
  IMAGE_GENERATION_ERROR_CODES,
  IMAGE_SIZES,
  IMAGE_QUALITIES,
  IMAGE_FORMATS,
  IMAGE_BACKGROUNDS,
  IMAGE_MIME_BY_FORMAT,
  IMAGE_EXTENSIONS_BY_FORMAT,
  IMAGE_GENERATION_LIMITS,
};
