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

module.exports = {};
