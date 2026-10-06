'use strict';

/**
 * Image generation in the main process (#85): the adapter, and the state the
 * tool list and the settings read.
 *
 * Whether the tool is offered has to be known synchronously while the tool
 * list is built, so the presence of the OpenAI key and the chosen model are
 * remembered here and brought up to date at start, after the settings are
 * saved and after the image model changes — the same arrangement as the web
 * search key.
 */

const {
  createOpenAiImageGenerationAdapter,
  DEFAULT_IMAGE_MODEL,
  isImageModel,
} = require('../adapters/openai-image-generation-adapter');

/**
 * @param {Object} deps
 * @param {() => Promise<string|null>} deps.readApiKey  the decrypted OpenAI key
 * @param {() => Promise<Object>} deps.readUIPrefs
 * @param {typeof fetch} [deps.fetchImpl]  left out in the app: the adapter looks fetch up per call
 */
function createImageGenerationSettings({ readApiKey, readUIPrefs, fetchImpl }) {
  let keyPresent = false;
  let chosenModel = '';

  const adapter = createOpenAiImageGenerationAdapter({
    readApiKey,
    hasApiKey: () => keyPresent,
    getModel: () => chosenModel || DEFAULT_IMAGE_MODEL,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  function describe() {
    return {
      // Offered to the model at all: an OpenAI key is there.
      hasApiKey: keyPresent,
      // What the next image is made with, and what the user picked ('' = default).
      model: adapter.getModel(),
      chosenModel,
      defaultModel: DEFAULT_IMAGE_MODEL,
    };
  }

  return {
    adapter,
    describe,
    async refresh() {
      const [key, prefs] = await Promise.all([
        Promise.resolve().then(readApiKey).catch(() => null),
        Promise.resolve().then(readUIPrefs).catch(() => null),
      ]);
      keyPresent = typeof key === 'string' && key.trim() !== '';
      chosenModel = isImageModel(prefs?.imageModel) ? prefs.imageModel.trim() : '';
      return describe();
    },
    listModels: (options) => adapter.listModels(options),
  };
}

module.exports = { createImageGenerationSettings };
