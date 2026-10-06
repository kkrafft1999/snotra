// The OpenAI image adapter (#85). fetch is a stub — nothing leaves the machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOpenAiImageGenerationAdapter,
  DEFAULT_IMAGE_MODEL,
  isImageModel,
} = require('../src/main/adapters/openai-image-generation-adapter');
const { IMAGE_GENERATION_ERROR_CODES: CODES } = require('../src/application/ports/image-generation-port');
const { normalizeImageModel, normalizeUiPrefs, normalizeUiPrefsPatch } = require('../src/shared/contracts/settings');

// 1x1 PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// A JPEG head is enough for the type check: FF D8 FF.
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');

function jsonResponse(status, body, headers = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function makeAdapter({ responses = [], key = 'sk-test', model, wait, timeoutMs, fetchImpl } = {}) {
  const calls = [];
  const waits = [];
  const queue = [...responses];
  const adapter = createOpenAiImageGenerationAdapter({
    readApiKey: async () => key,
    hasApiKey: () => !!key,
    ...(model !== undefined ? { getModel: () => model } : {}),
    baseUrl: 'https://api.example.test/v1/',
    wait: wait || (async (ms) => { waits.push(ms); }),
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl: fetchImpl || (async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      const next = queue.shift();
      if (!next) throw new Error('no response queued');
      if (typeof next === 'function') return next(url, options);
      return next;
    }),
  });
  return { adapter, calls, waits };
}

test('generate posts one image request and returns the decoded bytes (#85)', async () => {
  const { adapter, calls } = makeAdapter({
    responses: [jsonResponse(200, { data: [{ b64_json: PNG_B64, revised_prompt: 'a red fox, flat style' }] })],
  });
  const result = await adapter.generate({ prompt: '  a red fox ', size: '1536x1024', quality: 'high', format: 'png' });

  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.model, DEFAULT_IMAGE_MODEL);
  assert.ok(Buffer.isBuffer(result.bytes));
  assert.deepEqual(result.bytes, Buffer.from(PNG_B64, 'base64'));
  assert.equal(result.revisedPrompt, 'a red fox, flat style');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v1/images/generations');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body, {
    model: DEFAULT_IMAGE_MODEL,
    prompt: 'a red fox',
    n: 1,
    size: '1536x1024',
    quality: 'high',
    output_format: 'png',
  });
});

test('unknown sizes, qualities and formats fall back to the safe defaults', async () => {
  const { adapter, calls } = makeAdapter({ responses: [jsonResponse(200, { data: [{ b64_json: PNG_B64 }] })] });
  await adapter.generate({ prompt: 'x', size: '3840x2160', quality: 'max', format: 'gif', background: 'neon' });
  assert.equal(calls[0].body.size, '1024x1024');
  assert.equal(calls[0].body.quality, 'medium');
  assert.equal(calls[0].body.output_format, 'png');
  assert.equal('background' in calls[0].body, false);
});

test('the chosen model is used, a model outside the image family is not', async () => {
  const chosen = makeAdapter({ model: 'gpt-image-2.5-sunburst', responses: [jsonResponse(200, { data: [{ b64_json: PNG_B64 }] })] });
  await chosen.adapter.generate({ prompt: 'x' });
  assert.equal(chosen.calls[0].body.model, 'gpt-image-2.5-sunburst');

  const wrong = makeAdapter({ model: 'gpt-5.5', responses: [jsonResponse(200, { data: [{ b64_json: PNG_B64 }] })] });
  assert.equal(wrong.adapter.getModel(), DEFAULT_IMAGE_MODEL);
  await wrong.adapter.generate({ prompt: 'x' });
  assert.equal(wrong.calls[0].body.model, DEFAULT_IMAGE_MODEL);
});

test('a transparent background is asked for, but never with JPEG', async () => {
  const { adapter, calls } = makeAdapter({ responses: [jsonResponse(200, { data: [{ b64_json: PNG_B64 }] })] });
  const ok = await adapter.generate({ prompt: 'icon', format: 'png', background: 'transparent' });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].body.background, 'transparent');

  const refused = await adapter.generate({ prompt: 'icon', format: 'jpeg', background: 'transparent' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CODES.INVALID_REQUEST);
  assert.equal(calls.length, 1, 'nothing is sent for a request that cannot work');
});

test('an empty or overlong prompt and a missing key are refused before anything is sent', async () => {
  const { adapter, calls } = makeAdapter();
  assert.equal((await adapter.generate({ prompt: '   ' })).code, CODES.INVALID_REQUEST);
  assert.equal((await adapter.generate({ prompt: 'x'.repeat(4001) })).code, CODES.INVALID_REQUEST);
  const noKey = makeAdapter({ key: null });
  const result = await noKey.adapter.generate({ prompt: 'x' });
  assert.equal(result.code, CODES.NO_API_KEY);
  assert.match(result.error, /\{menu:settings\.models\}/);
  assert.equal(noKey.adapter.isConfigured(), false);
  assert.equal(calls.length + noKey.calls.length, 0);
});

test('a refused prompt is reported as refused and not retried', async () => {
  const { adapter, calls } = makeAdapter({
    responses: [jsonResponse(400, { error: { message: 'Your request was rejected by the safety system.', code: 'moderation_blocked' } })],
  });
  const result = await adapter.generate({ prompt: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.REFUSED);
  assert.match(result.error, /safety system/);
  assert.equal(calls.length, 1);
});

test('401 points the user at the key and the model', async () => {
  const { adapter } = makeAdapter({ responses: [jsonResponse(401, { error: { message: 'Incorrect API key provided' } })] });
  const result = await adapter.generate({ prompt: 'x' });
  assert.equal(result.code, CODES.UNAUTHORIZED);
  assert.match(result.error, /\{menu:settings\.tools\}/);
});

test('429 and 503 are retried with backoff — the service drew nothing yet', async () => {
  const { adapter, calls, waits } = makeAdapter({
    responses: [
      jsonResponse(429, { error: { message: 'Rate limit', code: 'rate_limit_exceeded' } }, { 'retry-after': '3' }),
      jsonResponse(503, { error: { message: 'Overloaded' } }),
      jsonResponse(200, { data: [{ b64_json: PNG_B64 }] }),
    ],
  });
  const result = await adapter.generate({ prompt: 'x' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [3000, 5000]);
});

test('retries stop after two, and a used-up quota is not retried at all', async () => {
  const busy = makeAdapter({
    responses: [503, 503, 503].map((status) => jsonResponse(status, { error: { message: 'Overloaded' } })),
  });
  const gaveUp = await busy.adapter.generate({ prompt: 'x' });
  assert.equal(gaveUp.code, CODES.SERVICE);
  assert.equal(busy.calls.length, 3);

  const broke = makeAdapter({
    responses: [jsonResponse(429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } })],
  });
  const quota = await broke.adapter.generate({ prompt: 'x' });
  assert.equal(quota.code, CODES.RATE_LIMITED);
  assert.match(quota.error, /retrying will not help/);
  assert.equal(broke.calls.length, 1);
});

test('a timeout is not retried — the image may already be billed', async () => {
  let calls = 0;
  const { adapter } = makeAdapter({
    timeoutMs: 20,
    fetchImpl: (url, options) => {
      calls += 1;
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const result = await adapter.generate({ prompt: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.TIMEOUT);
  assert.match(result.error, /billed/);
  assert.equal(calls, 1);
});

test('cancelling the run cancels the request', async () => {
  const controller = new AbortController();
  const { adapter } = makeAdapter({
    fetchImpl: (url, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      setTimeout(() => controller.abort(new Error('stop')), 5);
    }),
  });
  const result = await adapter.generate({ prompt: 'x', abortSignal: controller.signal });
  assert.equal(result.code, CODES.ABORTED);
});

test('an answer without an image, or with the wrong kind of bytes, is no success', async () => {
  const empty = makeAdapter({ responses: [jsonResponse(200, { data: [] })] });
  assert.equal((await empty.adapter.generate({ prompt: 'x' })).code, CODES.REFUSED);

  const wrong = makeAdapter({ responses: [jsonResponse(200, { data: [{ b64_json: JPEG_B64 }] })] });
  const result = await wrong.adapter.generate({ prompt: 'x', format: 'png' });
  assert.equal(result.code, CODES.SERVICE);

  const jpeg = makeAdapter({ responses: [jsonResponse(200, { data: [{ b64_json: JPEG_B64 }] })] });
  const ok = await jpeg.adapter.generate({ prompt: 'x', format: 'jpeg' });
  assert.equal(ok.ok, true);
  assert.equal(ok.mime, 'image/jpeg');
});

test('listModels names the image models the key reaches, nothing else', async () => {
  const { adapter, calls } = makeAdapter({
    responses: [jsonResponse(200, {
      data: [
        { id: 'gpt-5.5' },
        { id: 'gpt-image-2.5-sunburst' },
        { id: 'gpt-image-2.5-flare' },
        { id: 'whisper-1' },
        { id: 'gpt-image-2.5-flare' },
        { id: 'dall-e-3' },
      ],
    })],
  });
  const result = await adapter.listModels();
  assert.deepEqual(result, { models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] });
  assert.equal(calls[0].url, 'https://api.example.test/v1/models');

  const noKey = makeAdapter({ key: null });
  assert.deepEqual(await noKey.adapter.listModels(), { error: { key: 'settings.imageGeneration.error.noKey' } });
});

test('the image model preference keeps only ids of the image family', () => {
  assert.equal(isImageModel('gpt-image-2.5-flare'), true);
  assert.equal(isImageModel('chatgpt-image-latest'), true);
  assert.equal(isImageModel('gpt-5.5'), false);
  assert.equal(isImageModel('gpt-image-1; rm -rf /'), false);
  assert.equal(normalizeImageModel('  gpt-image-2  '), 'gpt-image-2');
  assert.equal(normalizeImageModel('x'.repeat(100)), '');

  assert.equal(normalizeUiPrefs({ imageModel: 'gpt-image-2' }).imageModel, 'gpt-image-2');
  assert.equal('imageModel' in normalizeUiPrefs({ imageModel: 'dall-e-3' }), false);
  // '' in a patch means "back to the default" and has to get through.
  assert.deepEqual(normalizeUiPrefsPatch({ imageModel: '' }), { imageModel: '' });
  assert.deepEqual(normalizeUiPrefsPatch({ imageModel: 'gpt-4o' }), { imageModel: '' });
});
