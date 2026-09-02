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

  assert.match(result.error, /ungültigen Function-Call/);
  assert.equal(result.code, 'API');
  assert.equal(result.message, undefined);
  assert.deepEqual(result.usage, { prompt: 7, completion: 2, total: 9 });
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
