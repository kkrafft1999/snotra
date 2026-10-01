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
