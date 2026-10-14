const test = require('node:test');
const assert = require('node:assert/strict');
const compat = require('../src/main/providers/openai-compatible');
const { streamChatCompletionsRound } = require('../src/main/providers/openai-chat-transport');
const { streamResponsesRound } = require('../src/main/providers/openai-responses-transport');
const { mergePresetConnection } = require('../src/main/ipc/settings-handlers');
const { getProvider } = require('../src/main/providers');
const {
  MAX_OUTPUT_TOKENS_MAX,
  isMaxOutputTokens,
  parseMaxOutputTokensInput,
  normalizeStoredPresetConnection,
  normalizePresetConnectionPatch,
  buildProviderFormView,
} = require('../src/shared/contracts/settings');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');

/**
 * The output limit of an OpenAI-compatible entry (#931): how it is typed,
 * stored, cleared, and which field it travels in.
 */

const BASE = 'https://gw.example/v1';
const COMPAT = getProvider('openai-compatible');

const chatDone = () => sseResponse([
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
]);
const responsesDone = () => sseResponse([
  `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
]);
const bodyOf = (call) => JSON.parse(call.options.body);

test.afterEach(() => compat.dispose());

// --- Transports --------------------------------------------------------------

test('Chat Completions: the limit goes out as max_tokens, and only when set', async (t) => {
  const calls = mockFetch(t, chatDone);
  const run = (extra) => streamChatCompletionsRound({
    baseUrl: BASE, headers: {}, model: 'm', messages: [], callbacks: collectCallbacks().callbacks, ...extra,
  });

  await run({ maxOutputTokens: 4096 });
  await run({});
  await run({ maxOutputTokens: 0 });

  assert.equal(bodyOf(calls[0]).max_tokens, 4096);
  assert.equal('max_completion_tokens' in bodyOf(calls[0]), false);
  assert.equal('max_tokens' in bodyOf(calls[1]), false);
  assert.equal('max_tokens' in bodyOf(calls[2]), false, 'an invalid value is not sent');
});

test('Chat Completions: a limit in extraBody wins, under either name', async (t) => {
  const calls = mockFetch(t, chatDone);
  const run = (extraBody) => streamChatCompletionsRound({
    baseUrl: BASE, headers: {}, model: 'm', messages: [], callbacks: collectCallbacks().callbacks,
    maxOutputTokens: 4096, extraBody,
  });

  await run({ max_tokens: 100 });
  await run({ max_completion_tokens: 200 });

  assert.equal(bodyOf(calls[0]).max_tokens, 100);
  assert.equal(bodyOf(calls[1]).max_completion_tokens, 200);
  assert.equal('max_tokens' in bodyOf(calls[1]), false);
});

test('Responses: the limit goes out as max_output_tokens; extraBody wins', async (t) => {
  const calls = mockFetch(t, responsesDone);
  const run = (extra) => streamResponsesRound({
    baseUrl: BASE, headers: {}, model: 'm', messages: [], callbacks: collectCallbacks().callbacks, ...extra,
  });

  await run({ maxOutputTokens: 2048 });
  await run({});
  await run({ maxOutputTokens: 2048, extraBody: { max_output_tokens: 50 } });

  assert.equal(bodyOf(calls[0]).max_output_tokens, 2048);
  assert.equal('max_tokens' in bodyOf(calls[0]), false);
  assert.equal('max_output_tokens' in bodyOf(calls[1]), false);
  assert.equal(bodyOf(calls[2]).max_output_tokens, 50);
});

// --- Provider ----------------------------------------------------------------

test('the provider passes the entry limit to /responses and to the Chat fallback', async (t) => {
  const calls = mockFetch(t, (url) => (url.endsWith('/responses')
    ? { ok: false, status: 404, statusText: 'Not Found', body: null, text: async () => '', json: async () => ({}) }
    : chatDone()));

  await compat.streamChatRound({
    config: { baseUrl: BASE, apiStyle: 'full', maxOutputTokens: 1234 },
    model: 'm',
    messages: [],
    callbacks: collectCallbacks().callbacks,
  });

  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ['/v1/responses', '/v1/chat/completions']);
  assert.equal(bodyOf(calls[0]).max_output_tokens, 1234);
  assert.equal(bodyOf(calls[1]).max_tokens, 1234);
  assert.equal('max_output_tokens' in bodyOf(calls[1]), false);
});

test('an entry without a limit sends none', async (t) => {
  const calls = mockFetch(t, chatDone);
  await compat.streamChatRound({
    config: { baseUrl: BASE },
    model: 'm',
    messages: [],
    callbacks: collectCallbacks().callbacks,
  });
  assert.equal('max_tokens' in bodyOf(calls[0]), false);
});

// --- Contract ----------------------------------------------------------------

test('the typed value: empty, plain, grouped, and everything that is refused', () => {
  assert.deepEqual(parseMaxOutputTokensInput(''), { value: null });
  assert.deepEqual(parseMaxOutputTokensInput('   '), { value: null });
  assert.deepEqual(parseMaxOutputTokensInput('8192'), { value: 8192 });
  assert.deepEqual(parseMaxOutputTokensInput(' 8,192 '), { value: 8192 });
  assert.deepEqual(parseMaxOutputTokensInput('8.192'), { value: 8192 });
  assert.deepEqual(parseMaxOutputTokensInput('1 000 000'), { value: MAX_OUTPUT_TOKENS_MAX });
  for (const wrong of ['0', '-5', '8.5', '1e4', '12abc', '1000001', '81,92', '+10']) {
    assert.deepEqual(parseMaxOutputTokensInput(wrong), { error: true }, wrong);
  }
  assert.equal(isMaxOutputTokens(1), true);
  assert.equal(isMaxOutputTokens(MAX_OUTPUT_TOKENS_MAX + 1), false);
  assert.equal(isMaxOutputTokens(10.5), false);
  assert.equal(isMaxOutputTokens('10'), false);
});

test('a stored limit survives normalising; a wrong one and a foreign provider drop it', () => {
  assert.equal(normalizeStoredPresetConnection({ maxOutputTokens: 4096 }, COMPAT).maxOutputTokens, 4096);
  assert.equal('maxOutputTokens' in normalizeStoredPresetConnection({ maxOutputTokens: 0 }, COMPAT), false);
  assert.equal('maxOutputTokens' in normalizeStoredPresetConnection({ maxOutputTokens: '4096' }, COMPAT), false);
  assert.equal('maxOutputTokens' in normalizeStoredPresetConnection({}, COMPAT), false, 'nothing is migrated in');
  const other = { ...COMPAT, fields: { ...COMPAT.fields, maxOutputTokens: false } };
  assert.equal('maxOutputTokens' in normalizeStoredPresetConnection({ maxOutputTokens: 4096 }, other), false);
});

test('the patch carries a value, a null to clear, and drops anything else', () => {
  assert.equal(normalizePresetConnectionPatch({ maxOutputTokens: 512 }, COMPAT).maxOutputTokens, 512);
  assert.equal(normalizePresetConnectionPatch({ maxOutputTokens: null }, COMPAT).maxOutputTokens, null);
  assert.equal('maxOutputTokens' in normalizePresetConnectionPatch({ maxOutputTokens: -1 }, COMPAT), false);
  assert.equal('maxOutputTokens' in normalizePresetConnectionPatch({}, COMPAT), false);
});

test('only the OpenAI-compatible form shows the field', () => {
  assert.equal(buildProviderFormView(COMPAT).showMaxOutputTokens, true);
  assert.equal(buildProviderFormView(getProvider('openai')).showMaxOutputTokens, false);
});

// --- Saving ------------------------------------------------------------------

test('saving sets, keeps and clears the stored limit', () => {
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s) };
  const merge = (previous, raw) => mergePresetConnection({ safeStorage }, {
    previous,
    patch: normalizePresetConnectionPatch(raw, COMPAT),
    provider: COMPAT,
  }).connection;

  const set = merge({ baseUrl: BASE }, { maxOutputTokens: 4096 });
  assert.equal(set.maxOutputTokens, 4096);
  assert.equal(merge(set, { displayName: 'x' }).maxOutputTokens, 4096, 'untouched is kept');
  assert.equal('maxOutputTokens' in merge(set, { maxOutputTokens: null }), false);
});
