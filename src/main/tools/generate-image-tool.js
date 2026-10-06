'use strict';

/**
 * The `generate_image` tool (#85): an image from a prompt, saved as a file in
 * the workspace.
 *
 * A tool rather than a chat mode, so the model can make an image as one step
 * of a larger task ("write the README and add a header image"), whichever
 * chat model runs. The service sits behind the image generation port; this
 * file only knows the workspace side:
 *
 * - The image is written like `write_file_text` writes text — inside the
 *   workspace, atomically, with a recovery copy of an image it replaces — so
 *   the planner, the approval card, the tree marks and "Show changes" treat it
 *   as the write it is. The prompt leaving the machine makes it `external` as
 *   well: in Smart mode every image is asked for.
 * - The model gets the path, the format and the size back, never the image:
 *   base64 would fill the context.
 * - Every call is billed. A run may make `MAX_IMAGES_PER_RUN` images; an
 *   agent left alone will happily loop on "make it a bit bluer".
 */

const path = require('path');
const { TOOL_RISK_CLASSES } = require('../../shared/contracts/tool-permissions');
const {
  IMAGE_GENERATION_ERROR_CODES,
  IMAGE_SIZES,
  IMAGE_QUALITIES,
  IMAGE_BACKGROUNDS,
  IMAGE_EXTENSIONS_BY_FORMAT,
  IMAGE_GENERATION_LIMITS: LIMITS,
} = require('../../application/ports/image-generation-port');
const { imageDimensions } = require('../services/image-dimensions');

const GENERATE_IMAGE_TOOL = 'generate_image';

/** How long a drawn image waits for a second approval after its write failed. */
const HELD_IMAGE_TTL_MS = 15 * 60 * 1000;
const MAX_HELD_IMAGES = 4;

function formatForPath(relativePath) {
  const ext = path.extname(String(relativePath || '')).toLowerCase();
  for (const [format, extensions] of Object.entries(IMAGE_EXTENSIONS_BY_FORMAT)) {
    if (extensions.includes(ext)) return format;
  }
  return null;
}

const SUPPORTED_EXTENSIONS = Object.values(IMAGE_EXTENSIONS_BY_FORMAT).flat();

/**
 * @param {Object} deps
 * @param {Object} deps.fsService  with `writeBinaryFileForTool`
 * @param {import('../../application/ports/image-generation-port').ImageGenerationPort|null} deps.imageGeneration
 * @param {() => number} [deps.now]
 */
function createGenerateImageTool({ fsService, imageGeneration = null, now = () => Date.now() }) {
  /**
   * Images made per run. A run has exactly one abort signal, created when the
   * turn starts, so the signal names the run without the engine handing out
   * an id for it; the entry goes when the run is collected.
   */
  const imagesPerRun = new WeakMap();

  /**
   * An image whose write failed after it was drawn — the recovery copy could
   * not be made, so the call comes back as `delete` and is asked for again.
   * The second approval writes the image already paid for instead of drawing
   * a new one. Keyed by the full set of arguments: a different request draws
   * afresh.
   */
  const heldImages = new Map();

  function heldKey(args) {
    return JSON.stringify([args.prompt, args.relative_path, args.size, args.quality, args.background]);
  }

  function takeHeldImage(key) {
    const held = heldImages.get(key);
    heldImages.delete(key);
    if (!held || now() - held.at > HELD_IMAGE_TTL_MS) return null;
    return held.image;
  }

  function holdImage(key, image) {
    heldImages.set(key, { image, at: now() });
    while (heldImages.size > MAX_HELD_IMAGES) heldImages.delete(heldImages.keys().next().value);
  }

  function countedImages(signal) {
    return signal ? imagesPerRun.get(signal) || 0 : 0;
  }

  function countImage(signal) {
    if (signal) imagesPerRun.set(signal, countedImages(signal) + 1);
  }

  function uncountImage(signal) {
    if (signal) imagesPerRun.set(signal, Math.max(0, countedImages(signal) - 1));
  }

  async function handler(args, { workspaceRoot, abortSignal, recovery, onWritten } = {}) {
    if (!imageGeneration) {
      return JSON.stringify({ error: 'Image generation is not available in this installation.' });
    }
    const rel = typeof args?.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) return JSON.stringify({ error: 'relative_path is required.' });
    const format = formatForPath(rel);
    if (!format) {
      return JSON.stringify({
        error: `relative_path must end in ${SUPPORTED_EXTENSIONS.join(', ')} — the extension decides the format.`,
      });
    }
    const request = {
      prompt: typeof args?.prompt === 'string' ? args.prompt : '',
      relative_path: rel,
      size: IMAGE_SIZES.includes(args?.size) ? args.size : LIMITS.DEFAULT_SIZE,
      quality: IMAGE_QUALITIES.includes(args?.quality) ? args.quality : LIMITS.DEFAULT_QUALITY,
      background: IMAGE_BACKGROUNDS.includes(args?.background) ? args.background : 'auto',
    };
    const key = heldKey(request);

    let image = takeHeldImage(key);
    if (!image) {
      if (countedImages(abortSignal) >= LIMITS.MAX_IMAGES_PER_RUN) {
        return JSON.stringify({
          error: `This turn has already made ${LIMITS.MAX_IMAGES_PER_RUN} images, the most one turn may make. `
            + 'Show the user what you have and let them ask for more.',
          code: 'image_limit_reached',
        });
      }
      // Counted before the call: a timeout may already have been billed.
      countImage(abortSignal);
      image = await imageGeneration.generate({
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        format,
        background: request.background,
        abortSignal,
      });
      if (!image?.ok) {
        // A request that never reached the service costs nothing.
        if (image?.code === IMAGE_GENERATION_ERROR_CODES.INVALID_REQUEST
          || image?.code === IMAGE_GENERATION_ERROR_CODES.NO_API_KEY) {
          uncountImage(abortSignal);
        }
        return JSON.stringify({ error: image?.error || 'The image could not be generated.', code: image?.code });
      }
    }

    const written = await fsService.writeBinaryFileForTool(rel, image.bytes, workspaceRoot, { recovery, onWritten });
    if (written.error) {
      if (written.code === 'recovery_failed') holdImage(key, image);
      return JSON.stringify(written);
    }
    const out = {
      relative_path: written.relative_path,
      created: written.created,
      overwritten: written.overwritten,
      bytes_written: written.bytes_written,
      format,
      mime: image.mime,
      model: image.model,
    };
    const size = imageDimensions(image.bytes, image.mime);
    if (size) {
      out.width = size.width;
      out.height = size.height;
    }
    if (image.revisedPrompt) out.revised_prompt = image.revisedPrompt;
    if (written.recovery_copy_in_trash) out.recovery_copy_in_trash = written.recovery_copy_in_trash;
    if (abortSignal) out.images_left_this_turn = Math.max(0, LIMITS.MAX_IMAGES_PER_RUN - countedImages(abortSignal));
    return JSON.stringify(out);
  }

  return {
    name: GENERATE_IMAGE_TOOL,
    // Writes a file, and the prompt leaves the machine to a service that
    // bills it: `write` for the target, `external` for the request.
    riskClass: TOOL_RISK_CLASSES.WRITE,
    additionalRiskClasses: [TOOL_RISK_CLASSES.EXTERNAL],
    // Replacing an image keeps a copy in the trash, like write_file_text.
    mayOverwrite: true,
    targets: (args) => [{ path: args.relative_path, kind: 'file', access: 'write', overwrite: true }],
    isAvailable: () => imageGeneration?.isConfigured() === true,
    descriptionKey: 'tools.desc.generate_image',
    modelDescription:
      'Generates an image from a text prompt with an image model and saves it as a file in the project. '
      + 'The prompt leaves the machine and every image is billed, so make one image per request and '
      + 'describe it fully: subject, style, composition, colours, any text it must show. '
      + 'The file extension of relative_path decides the format (.png, .jpg, .jpeg, .webp). '
      + `At most ${LIMITS.MAX_IMAGES_PER_RUN} images per turn. `
      + 'The user sees the image in the chat; refer to it by its path instead of embedding it again.',
    shortDescriptionKey: 'tools.short.generate_image',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          maxLength: LIMITS.MAX_PROMPT_CHARS,
          description: 'What the image shows, as a complete description in natural language.',
        },
        relative_path: {
          type: 'string',
          description: 'Target file in the project, e.g. "docs/header.png". Missing folders are created.',
        },
        size: {
          type: 'string',
          enum: [...IMAGE_SIZES],
          default: LIMITS.DEFAULT_SIZE,
          description: 'Width x height: square, landscape or portrait.',
        },
        quality: {
          type: 'string',
          enum: [...IMAGE_QUALITIES],
          default: LIMITS.DEFAULT_QUALITY,
          description: 'Higher quality takes longer and costs more. Use "low" for drafts.',
        },
        background: {
          type: 'string',
          enum: [...IMAGE_BACKGROUNDS],
          default: 'auto',
          description: '"transparent" for icons and cut-outs; needs .png or .webp.',
        },
      },
      required: ['prompt', 'relative_path'],
    },
    handler,
  };
}

module.exports = { createGenerateImageTool, GENERATE_IMAGE_TOOL };
