'use strict';

/**
 * Constants of the image generation (#85): the error codes, the options the tool
 * offers and the bounds of a call. The shape of a call is the port's business
 * (`application/ports/image-generation-port.js`, types only); the values live
 * here so that a port file stays a type declaration (#1098).
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

/** @type {Readonly<Record<string, string>>} */
const IMAGE_MIME_BY_FORMAT = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

/** The file extensions that match a format, the first one preferred. */
/** @type {Readonly<Record<string, readonly string[]>>} */
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
