const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhisperService } = require('../src/main/services/whisper-service');

function makeFetchStub(t, impl) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  return { fetchImpl, calls };
}

test('transcribeAudio returns an error when no OpenAI key is stored', async () => {
  const svc = createWhisperService({
    fetchImpl: async () => { throw new Error('must not be called'); },
    credentials: { getApiKey: async () => '' },
    speechProviderId: 'openai',
    getAppLocale: async () => 'de',
  });
  const res = await svc.transcribeAudio(Buffer.from('audio'));
  assert.deepEqual(res.error, { key: 'chat.voice.error.noApiKey' });
});

test('transcribeAudio sends a multipart body with the resolved language and API key', async (t) => {
  const { fetchImpl, calls } = makeFetchStub(t, async () => ({
    ok: true,
    json: async () => ({ text: 'Hallo Welt' }),
  }));
  const svc = createWhisperService({
    fetchImpl,
    credentials: { getApiKey: async () => 'sk-test-123' },
    speechProviderId: 'openai',
    getAppLocale: async () => 'de',
  });

  const res = await svc.transcribeAudio(Buffer.from('fake-audio-bytes'));
  assert.deepEqual(res, { text: 'Hallo Welt' });

  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer sk-test-123');
  assert.match(options.headers['Content-Type'], /^multipart\/form-data; boundary=/);

  const bodyText = options.body.toString('utf8');
  assert.match(bodyText, /name="model"\r\n\r\nwhisper-1/);
  assert.match(bodyText, /name="language"\r\n\r\nde/);
  assert.match(bodyText, /name="response_format"\r\n\r\njson/);
  assert.match(bodyText, /name="file"; filename="voice\.webm"/);
  assert.match(bodyText, /Content-Type: audio\/webm/);
});

test('transcribeAudio prefers an explicit language option over the app locale', async (t) => {
  const { fetchImpl, calls } = makeFetchStub(t, async () => ({
    ok: true,
    json: async () => ({ text: 'Hi' }),
  }));
  const svc = createWhisperService({
    fetchImpl,
    credentials: { getApiKey: async () => 'sk-test' },
    speechProviderId: 'openai',
    getAppLocale: async () => 'de',
  });

  await svc.transcribeAudio(Buffer.from('x'), { language: 'en' });
  assert.match(calls[0].options.body.toString('utf8'), /name="language"\r\n\r\nen/);
});

test('transcribeAudio falls back to "de" when no locale getter is provided and no language given', async (t) => {
  const { fetchImpl, calls } = makeFetchStub(t, async () => ({
    ok: true,
    json: async () => ({ text: '' }),
  }));
  const svc = createWhisperService({
    fetchImpl,
    credentials: { getApiKey: async () => 'sk-test' },
    speechProviderId: 'openai',
  });

  await svc.transcribeAudio(Buffer.from('x'));
  assert.match(calls[0].options.body.toString('utf8'), /name="language"\r\n\r\nde/);
});

test('transcribeAudio maps a non-"en" app locale to "de"', async (t) => {
  const { fetchImpl, calls } = makeFetchStub(t, async () => ({
    ok: true,
    json: async () => ({ text: '' }),
  }));
  const svc = createWhisperService({
    fetchImpl,
    credentials: { getApiKey: async () => 'sk-test' },
    speechProviderId: 'openai',
    getAppLocale: async () => 'fr',
  });

  await svc.transcribeAudio(Buffer.from('x'));
  assert.match(calls[0].options.body.toString('utf8'), /name="language"\r\n\r\nde/);
});

test('transcribeAudio returns an empty string when the API omits text', async (t) => {
  const { fetchImpl } = makeFetchStub(t, async () => ({
    ok: true,
    json: async () => ({}),
  }));
  const svc = createWhisperService({
    fetchImpl,
    credentials: { getApiKey: async () => 'sk-test' },
    speechProviderId: 'openai',
    getAppLocale: async () => 'de',
  });

  const res = await svc.transcribeAudio(Buffer.from('x'));
  assert.deepEqual(res, { text: '' });
});

test('transcribeAudio surfaces a JSON error message from a failed HTTP response', async (t) => {
  const { fetchImpl } = makeFetchStub(t, async () => ({
    ok: false,
    statusText: 'Bad Request',
    text: async () => JSON.stringify({ error: { message: 'Datei zu groß' } }),
  }));
  const svc = createWhisperService({
    fetchImpl,
    credentials: { getApiKey: async () => 'sk-test' },
    speechProviderId: 'openai',
    getAppLocale: async () => 'de',
  });

  const res = await svc.transcribeAudio(Buffer.from('x'));
  assert.deepEqual(res, { error: 'Datei zu groß' });
});

test('transcribeAudio falls back to statusText when the error body is not JSON', async (t) => {
  const { fetchImpl } = makeFetchStub(t, async () => ({
    ok: false,
    statusText: 'Service Unavailable',
    text: async () => 'not json at all',
  }));
  const svc = createWhisperService({
    fetchImpl,
    credentials: { getApiKey: async () => 'sk-test' },
    speechProviderId: 'openai',
    getAppLocale: async () => 'de',
  });

  const res = await svc.transcribeAudio(Buffer.from('x'));
  assert.deepEqual(res, { error: 'Service Unavailable' });
});

test('transcribeAudio reports network failures as an error instead of throwing', async () => {
  const svc = createWhisperService({
    fetchImpl: async () => { throw new Error('fetch failed: ECONNRESET'); },
    credentials: { getApiKey: async () => 'sk-test' },
    speechProviderId: 'openai',
    getAppLocale: async () => 'de',
  });

  const res = await svc.transcribeAudio(Buffer.from('x'));
  assert.match(res.error, /ECONNRESET/);
});
