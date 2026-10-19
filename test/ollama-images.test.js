// Image attachments for Ollama (#92): plain base64 in the message's `images`.
const test = require('node:test');
const assert = require('node:assert/strict');
const ollama = require('../src/main/providers/ollama');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');

const PNG = 'iVBORw0KGgo=';
const JPEG = '/9j/4AAQSkZJRg==';
const GIF = 'R0lGODlhAQABAAAAACw=';
const WEBP = 'UklGRhoAAABXRUJQVlA4';

function image(mediaType, dataBase64) {
  return { kind: 'image', mediaType, dataBase64 };
}

const translate = (messages) => ollama.translateMessagesToOllama(messages);

test.after(() => ollama.destroyInsecureDispatcher());

test('the Ollama adapter passes images, in every format Snotra attaches (#92)', () => {
  assert.equal(ollama.capabilities.images.supported, true);
  assert.equal(ollama.capabilities.images.mediaTypes, undefined);
});

test('text and image: the text stays the content, the image goes into images', () => {
  assert.deepEqual(translate([
    { role: 'user', content: 'What is on this?', attachments: [image('image/png', PNG)] },
  ]), [{ role: 'user', content: 'What is on this?', images: [PNG] }]);
});

test('image only: an empty content and the image', () => {
  assert.deepEqual(translate([{ role: 'user', content: '', attachments: [image('image/jpeg', JPEG)] }]), [
    { role: 'user', content: '', images: [JPEG] },
  ]);
});

test('all four formats go along, in order', () => {
  const [row] = translate([{
    role: 'user',
    content: 'compare',
    attachments: [image('image/png', PNG), image('image/jpeg', JPEG), image('image/gif', GIF), image('image/webp', WEBP)],
  }]);
  assert.deepEqual(row.images, [PNG, JPEG, GIF, WEBP]);
});

test('a data: prefix is cut off — Ollama reads plain base64 only', () => {
  const [row] = translate([{
    role: 'user',
    content: 'look',
    attachments: [image('image/png', `data:image/png;base64,${PNG}`)],
  }]);
  assert.deepEqual(row.images, [PNG]);
});

test('an unsupported type or a stored reference without data is not forwarded', () => {
  assert.deepEqual(translate([{
    role: 'user',
    content: 'look',
    attachments: [
      image('image/tiff', 'AAAA'),
      { kind: 'image', mediaType: 'image/png', file: 'a'.repeat(32) + '.png' },
    ],
  }]), [{ role: 'user', content: 'look' }]);
});

test('history replay: earlier user turns keep their images, other roles get none', () => {
  const rows = translate([
    { role: 'system', content: 'be brief', attachments: [image('image/png', PNG)] },
    { role: 'user', content: 'first', attachments: [image('image/png', PNG)] },
    { role: 'assistant', content: 'a cat' },
    { role: 'user', content: 'and now?' },
  ]);
  assert.deepEqual(rows, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'first', images: [PNG] },
    { role: 'assistant', content: 'a cat' },
    { role: 'user', content: 'and now?' },
  ]);
});

test('the request body carries the images', async (t) => {
  const calls = mockFetch(t, () => sseResponse([
    `${JSON.stringify({ message: { role: 'assistant', content: 'A cat.' }, done: false })}\n`,
    `${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 })}\n`,
  ]));
  await ollama.streamChatRound({
    config: { baseUrl: 'http://localhost:11434' },
    model: 'gemma3',
    messages: [{ role: 'user', content: 'What is this?', attachments: [image('image/png', PNG)] }],
    callbacks: collectCallbacks().callbacks,
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'What is this?', images: [PNG] }]);
});
