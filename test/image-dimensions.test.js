// Width and height from the image head (#85), and the image generation
// settings that decide whether generate_image is offered.

const test = require('node:test');
const assert = require('node:assert/strict');
const { imageDimensions } = require('../src/main/services/image-dimensions');
const { createImageGenerationSettings } = require('../src/main/services/image-generation-settings');

function png(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    // APP0, 16 bytes
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // SOF0: length 17, precision 8, height, width
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

function webp(chunk, payload) {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write(chunk, 12, 'ascii');
  Buffer.from(payload).copy(buf, 20);
  return buf;
}

test('PNG, JPEG and the three WebP flavours give their size', () => {
  assert.deepEqual(imageDimensions(png(1536, 1024), 'image/png'), { width: 1536, height: 1024 });
  assert.deepEqual(imageDimensions(jpeg(1024, 1536), 'image/jpeg'), { width: 1024, height: 1536 });

  // VP8X: 24-bit width-1 and height-1 after four bytes of flags.
  const vp8x = [0, 0, 0, 0, 0xff, 0x05, 0x00, 0xff, 0x03, 0x00];
  assert.deepEqual(imageDimensions(webp('VP8X', vp8x), 'image/webp'), { width: 1536, height: 1024 });

  // VP8L: signature, then 14 bits each.
  const bits = (1024 - 1) | ((1024 - 1) << 14);
  const vp8l = [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff];
  assert.deepEqual(imageDimensions(webp('VP8L', vp8l), 'image/webp'), { width: 1024, height: 1024 });

  // VP8: frame tag, start code, then 14-bit sizes.
  const vp8 = [0, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x04, 0x00, 0x06];
  assert.deepEqual(imageDimensions(webp('VP8 ', vp8), 'image/webp'), { width: 1024, height: 1536 });
});

test('anything it does not understand gives null, never a throw', () => {
  assert.equal(imageDimensions(Buffer.from('not an image'), 'image/png'), null);
  assert.equal(imageDimensions(png(0, 10), 'image/png'), null);
  assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'), null);
  assert.equal(imageDimensions(png(10, 10), 'image/gif'), null);
  assert.equal(imageDimensions('png', 'image/png'), null);
});

test('the settings follow the OpenAI key and the chosen model', async () => {
  let key = null;
  let prefs = {};
  const settings = createImageGenerationSettings({
    readApiKey: async () => key,
    readUIPrefs: async () => prefs,
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  assert.equal(settings.adapter.isConfigured(), false);

  key = 'sk-test';
  prefs = { imageModel: 'gpt-image-2.5-sunburst' };
  const state = await settings.refresh();
  assert.equal(state.hasApiKey, true);
  assert.equal(state.model, 'gpt-image-2.5-sunburst');
  assert.equal(state.chosenModel, 'gpt-image-2.5-sunburst');
  assert.equal(state.defaultModel, 'gpt-image-2.5-flare');
  assert.equal(settings.adapter.isConfigured(), true);

  key = '  ';
  prefs = { imageModel: 'gpt-5.5' };
  const cleared = await settings.refresh();
  assert.equal(cleared.hasApiKey, false);
  assert.equal(cleared.chosenModel, '');
  assert.equal(cleared.model, 'gpt-image-2.5-flare');
  assert.equal(settings.adapter.isConfigured(), false);
});

test('an unreadable key or preference file is "no key", not a crash', async () => {
  const settings = createImageGenerationSettings({
    readApiKey: async () => { throw new Error('locked'); },
    readUIPrefs: () => { throw new Error('broken'); },
  });
  const state = await settings.refresh();
  assert.equal(state.hasApiKey, false);
  assert.equal(state.chosenModel, '');
});
