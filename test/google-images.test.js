// Image attachments for Google Gemini (#91): the user turn gets inline-data parts.
const test = require('node:test');
const assert = require('node:assert/strict');
const google = require('../src/main/providers/google');
const { mockFetch, sseResponse, collectCallbacks } = require('./helpers/sse');

const PNG = 'iVBORw0KGgo=';
const JPEG = '/9j/4AAQSkZJRg==';
const GIF = 'R0lGODlhAQABAAAAACw=';
const WEBP = 'UklGRhoAAABXRUJQVlA4';

function image(mediaType, dataBase64) {
  return { kind: 'image', mediaType, dataBase64 };
}

function inline(mimeType, data) {
  return { inlineData: { mimeType, data } };
}

function translate(messages) {
  return google.translateMessagesToGoogle(messages).contents;
}

test('the Google adapter passes images, GIF excepted (#91)', () => {
  assert.equal(google.capabilities.images, true);
  assert.deepEqual([...google.capabilities.imageMediaTypes], ['image/png', 'image/jpeg', 'image/webp']);
});

test('text and image: the inline data comes first, then the text', () => {
  assert.deepEqual(translate([
    { role: 'user', content: 'What is on this?', attachments: [image('image/png', PNG)] },
  ]), [{ role: 'user', parts: [inline('image/png', PNG), { text: 'What is on this?' }] }]);
});

test('image only: no empty text part', () => {
  assert.deepEqual(translate([{ role: 'user', content: '', attachments: [image('image/jpeg', JPEG)] }]), [
    { role: 'user', parts: [inline('image/jpeg', JPEG)] },
  ]);
});

test('a GIF is left out, the other images and the text go along', () => {
  assert.deepEqual(translate([{
    role: 'user',
    content: 'compare',
    attachments: [image('image/png', PNG), image('image/gif', GIF), image('image/webp', WEBP)],
  }]), [{ role: 'user', parts: [inline('image/png', PNG), inline('image/webp', WEBP), { text: 'compare' }] }]);
});

test('only a GIF: the message stays text, as before', () => {
  assert.deepEqual(translate([{ role: 'user', content: 'look', attachments: [image('image/gif', GIF)] }]), [
    { role: 'user', parts: [{ text: 'look' }] },
  ]);
});

test('an attachment that carries no data (stored reference) is not forwarded', () => {
  assert.deepEqual(translate([{
    role: 'user',
    content: 'look',
    attachments: [{ kind: 'image', mediaType: 'image/png', file: 'a'.repeat(32) + '.png' }],
  }]), [{ role: 'user', parts: [{ text: 'look' }] }]);
});

test('history replay: earlier user turns keep their images', () => {
  const contents = translate([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'first', attachments: [image('image/png', PNG)] },
    { role: 'assistant', content: 'a cat' },
    { role: 'user', content: 'and now?' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '', attachments: [image('image/webp', WEBP)] },
  ]);
  assert.deepEqual(contents.map((c) => c.role), ['user', 'model', 'user', 'model', 'user']);
  assert.deepEqual(contents[0].parts, [inline('image/png', PNG), { text: 'first' }]);
  assert.deepEqual(contents[2].parts, [{ text: 'and now?' }]);
  assert.deepEqual(contents[4].parts, [inline('image/webp', WEBP)]);
});

test('the request body carries the inline data', async (t) => {
  const calls = mockFetch(t, () => sseResponse([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A cat.' }] }, finishReason: 'STOP' }] })}\n\n`,
  ]));
  await google.streamChatRound({
    config: { apiKey: 'k' },
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'What is this?', attachments: [image('image/png', PNG)] }],
    callbacks: collectCallbacks().callbacks,
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [inline('image/png', PNG), { text: 'What is this?' }] }]);
});
