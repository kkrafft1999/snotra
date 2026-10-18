const test = require('node:test');
const assert = require('node:assert/strict');
const google = require('../src/main/providers/google');

function sseResponse(payloads) {
  const encoder = new TextEncoder();
  const chunks = payloads.map((p) => encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
  let i = 0;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
          releaseLock() {},
        };
      },
    },
  };
}

const noopCallbacks = {
  onTextDelta() {},
  onReasoningDelta() {},
  onMarkGenerating() {},
};

async function streamWithMockedFetch(payloads, callbacks = noopCallbacks) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(payloads);
  try {
    return await google.streamChatRound({
      config: { apiKey: 'test-key' },
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: undefined,
      callbacks,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('google streamChatRound returns error on MALFORMED_FUNCTION_CALL', async () => {
  const result = await streamWithMockedFetch([
    {
      candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
    },
  ]);

  assert.deepEqual(result.error, { key: 'provider.error.malformedFunctionCall' });
  assert.equal(result.code, 'API');
  assert.equal(result.message, undefined);
  assert.deepEqual(result.usage, { prompt: 7, completion: 2, total: 9, cached: 0 });
});

test('google streamChatRound maps function calls to tool_calls', async () => {
  const toolCallStarts = [];
  const result = await streamWithMockedFetch([
    {
      candidates: [{
        content: { parts: [{ functionCall: { name: 'list_directory', args: { relative_path: '.' } } }] },
        finishReason: 'STOP',
      }],
    },
  ], { ...noopCallbacks, onToolCallStart: (call) => toolCallStarts.push(call) });

  assert.equal(result.error, undefined);
  // Google liefert den Aufruf komplett — die Meldung trägt die Argumente direkt.
  assert.deepEqual(toolCallStarts, [{ index: 0, name: 'list_directory', args: { relative_path: '.' } }]);
  assert.equal(result.message.tool_calls.length, 1);
  assert.equal(result.message.tool_calls[0].function.name, 'list_directory');
});

// #540: empty answers and Gemini's thought signatures.
const { sseResponse: helperSse, mockFetch, collectCallbacks } = require('./helpers/sse');

test('an empty assistant turn is left out and the turns still alternate (#540)', () => {
  const { contents } = google.translateMessagesToGoogle([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'again' },
  ]);
  assert.deepEqual(contents, [{ role: 'user', parts: [{ text: 'q' }, { text: 'again' }] }]);
});

test('the responses to parallel calls share one turn (#540)', () => {
  const { contents } = google.translateMessagesToGoogle([
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'one', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'two', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', content: '{"ok":1}' },
    { role: 'tool', tool_call_id: 'b', content: '{"ok":2}' },
  ]);
  assert.deepEqual(contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.deepEqual(contents[2].parts.map((p) => p.functionResponse.name), ['one', 'two']);
});

test('a thought signature survives stream → history → request (#540)', async (t) => {
  const calls = mockFetch(t, () => helperSse([
    `data: ${JSON.stringify({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'list_directory', args: { relative_path: '.' } }, thoughtSignature: 'sig-123' }] },
        finishReason: 'STOP',
      }],
    })}\n\n`,
  ]));
  const first = await google.streamChatRound({
    config: { apiKey: 'k' },
    model: 'gemini-3-pro-preview',
    messages: [{ role: 'user', content: 'list' }],
    callbacks: collectCallbacks().callbacks,
  });
  assert.equal(first.message.tool_calls[0].thoughtSignature, 'sig-123');

  await google.streamChatRound({
    config: { apiKey: 'k' },
    model: 'gemini-3-pro-preview',
    messages: [
      { role: 'user', content: 'list' },
      first.message,
      { role: 'tool', tool_call_id: first.message.tool_calls[0].id, content: '{"entries":[]}' },
    ],
    callbacks: collectCallbacks().callbacks,
  });
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body.contents[1].parts[0], {
    functionCall: { name: 'list_directory', args: { relative_path: '.' } },
    thoughtSignature: 'sig-123',
  });
});

test('the key travels as a header, never in a URL (#541)', async (t) => {
  const calls = mockFetch(t, (url) => (url.includes('/models?')
    ? { ok: true, json: async () => ({ models: [] }) }
    : helperSse([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] })}\n\n`])));
  await google.listModels({ apiKey: 'AIza-secret' });
  await google.streamChatRound({
    config: { apiKey: 'AIza-secret' },
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
    callbacks: collectCallbacks().callbacks,
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url.includes('AIza-secret'), false, call.url);
    assert.equal(call.options.headers['x-goog-api-key'], 'AIza-secret');
  }
});

test('a thought part is thinking, not answer text (#541)', async (t) => {
  mockFetch(t, () => helperSse([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Let me think', thought: true }, { text: 'Answer' }] }, finishReason: 'STOP' }] })}\n\n`,
  ]));
  const sink = collectCallbacks();
  const res = await google.streamChatRound({
    config: { apiKey: 'k' },
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'q' }],
    callbacks: sink.callbacks,
  });
  assert.equal(res.message.content, 'Answer');
  assert.deepEqual(sink.reasoningDeltas, ['Let me think']);
});

// Reasoning levels (#994).

const { reasoningLevelsFor, reasoningDefaultFor } = require('../src/shared/contracts/reasoning');

function geminiAnswer() {
  return helperSse([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Weighing it', thought: true }, { text: 'Answer' }] }, finishReason: 'STOP' }] })}\n\n`,
  ]);
}

async function bodyFor(t, model, reasoningEffort) {
  const calls = mockFetch(t, () => geminiAnswer());
  const sink = collectCallbacks();
  const res = await google.streamChatRound({
    config: { apiKey: 'k', reasoningEffort },
    model,
    messages: [{ role: 'user', content: 'q' }],
    callbacks: sink.callbacks,
  });
  return { body: JSON.parse(calls[0].options.body), res, sink };
}

test('every Gemini model that thinks offers the levels it takes (#994)', () => {
  assert.deepEqual(reasoningLevelsFor(google, 'gemini-2.5-pro'), ['low', 'medium', 'high']);
  assert.deepEqual(reasoningLevelsFor(google, 'models/gemini-2.5-flash-lite'), ['low', 'medium', 'high']);
  assert.deepEqual(reasoningLevelsFor(google, 'gemini-3-pro-preview'), ['low', 'high']);
  assert.deepEqual(reasoningLevelsFor(google, 'gemini-3.1-pro-preview'), ['low', 'medium', 'high']);
  assert.deepEqual(reasoningLevelsFor(google, 'gemini-3-flash-preview'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(reasoningLevelsFor(google, 'gemini-3.8-flash'), ['low', 'medium', 'high']);
  for (const model of ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemma-3-27b-it', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-preview-tts']) {
    assert.deepEqual(reasoningLevelsFor(google, model), [], model);
  }
  assert.equal(reasoningDefaultFor(google, 'gemini-2.5-pro'), 'medium');
  // 3 Pro has no medium; it starts at high, its own default.
  assert.equal(reasoningDefaultFor(google, 'gemini-3-pro-preview'), 'high');
});

test('Gemini 3 gets a thinking level, with the thoughts streamed as reasoning (#994)', async (t) => {
  const { body, res, sink } = await bodyFor(t, 'gemini-3-flash-preview', 'minimal');
  assert.deepEqual(body.generationConfig, { thinkingConfig: { includeThoughts: true, thinkingLevel: 'MINIMAL' } });
  assert.equal(res.message.content, 'Answer');
  assert.deepEqual(sink.reasoningDeltas, ['Weighing it']);
});

test('Gemini 2.5 gets a thinking budget instead (#994)', async (t) => {
  const { body } = await bodyFor(t, 'gemini-2.5-pro', 'high');
  assert.deepEqual(body.generationConfig, { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } });
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, undefined);
});

test('a model without thinking, or a level it lacks, gets no thinkingConfig (#994)', async (t) => {
  for (const [model, level] of [['gemini-2.0-flash', 'high'], ['gemini-3-pro-preview', 'medium'], ['gemini-2.5-flash', undefined]]) {
    const { body } = await bodyFor(t, model, level);
    assert.equal(body.generationConfig, undefined, `${model} ${level}`);
  }
});
