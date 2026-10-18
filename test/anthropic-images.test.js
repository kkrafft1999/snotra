// Image attachments for Anthropic (#90): the user turn becomes content blocks.
const test = require('node:test');
const assert = require('node:assert/strict');
const anthropic = require('../src/main/providers/anthropic');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');

const PNG = 'iVBORw0KGgo=';
const JPEG = '/9j/4AAQSkZJRg==';
const GIF = 'R0lGODlhAQABAAAAACw=';
const WEBP = 'UklGRhoAAABXRUJQVlA4';

function image(mediaType, dataBase64) {
  return { kind: 'image', mediaType, dataBase64 };
}

function translate(messages) {
  return anthropic.translateMessagesToAnthropic(messages).messages;
}

test('the Anthropic adapter declares that it passes images (#90)', () => {
  assert.equal(anthropic.capabilities.images, true);
});

test('text and image: the image block comes first, then the text', () => {
  const messages = translate([
    { role: 'user', content: 'What is on this?', attachments: [image('image/png', PNG)] },
  ]);
  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: 'What is on this?' },
    ],
  }]);
});

test('image only: no empty text block', () => {
  const messages = translate([{ role: 'user', content: '', attachments: [image('image/jpeg', JPEG)] }]);
  assert.deepEqual(messages, [{
    role: 'user',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } }],
  }]);
  assert.equal(JSON.stringify(messages).includes('"text"'), false);
});

test('an unsupported media type is dropped, not forwarded', () => {
  const messages = translate([{
    role: 'user',
    content: 'look',
    attachments: [image('image/tiff', 'AAAA'), image('application/pdf', 'AAAA'), image('image/webp', WEBP)],
  }]);
  assert.deepEqual(messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: WEBP } },
    { type: 'text', text: 'look' },
  ]);
});

test('only unsupported attachments: the message stays a plain string', () => {
  const messages = translate([{ role: 'user', content: 'look', attachments: [image('image/bmp', 'AAAA')] }]);
  assert.deepEqual(messages, [{ role: 'user', content: 'look' }]);
});

test('an attachment that carries no data (stored reference) is not forwarded', () => {
  const messages = translate([{
    role: 'user',
    content: 'look',
    attachments: [{ kind: 'image', mediaType: 'image/png', file: 'a'.repeat(32) + '.png' }],
  }]);
  assert.deepEqual(messages, [{ role: 'user', content: 'look' }]);
});

test('several images keep their order, in front of the text', () => {
  const messages = translate([{
    role: 'user',
    content: 'compare',
    attachments: [image('image/png', PNG), image('image/jpeg', JPEG), image('image/gif', GIF)],
  }]);
  assert.deepEqual(messages[0].content.map((b) => b.type === 'image' ? b.source.media_type : b.type), [
    'image/png', 'image/jpeg', 'image/gif', 'text',
  ]);
});

test('history replay: earlier user messages keep their images', () => {
  const messages = translate([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'first', attachments: [image('image/png', PNG)] },
    { role: 'assistant', content: 'a cat' },
    { role: 'user', content: 'and now?' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '', attachments: [image('image/webp', WEBP)] },
  ]);
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    { type: 'text', text: 'first' },
  ]);
  assert.deepEqual(messages[2], { role: 'user', content: 'and now?' });
  assert.deepEqual(messages[4].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: WEBP } },
  ]);
});

test('a message without attachments is unchanged', () => {
  assert.deepEqual(translate([{ role: 'user', content: 'hi' }]), [{ role: 'user', content: 'hi' }]);
});

test('the request body carries the image blocks', async (t) => {
  const calls = mockFetch(t, () => sseResponse([
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ]));
  const sink = collectCallbacks();
  await anthropic.streamChatRound({
    config: { apiKey: 'sk-ant-test' },
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'What is this?', attachments: [image('image/png', PNG)] }],
    callbacks: sink.callbacks,
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    { type: 'text', text: 'What is this?' },
  ]);
});
