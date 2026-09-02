const test = require('node:test');
const assert = require('node:assert/strict');
const openai = require('../src/main/providers/openai');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');

const CONFIG = { apiKey: 'sk-test' };

function sse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

test('streamChatRound requires an API key', async () => {
  const res = await openai.streamChatRound({ config: {}, model: 'gpt-4o', messages: [] });
  assert.equal(res.code, 'NO_API_KEY');
});

test('streamChatRound accumulates text deltas and usage from the SSE stream', async (t) => {
  const calls = mockFetch(t, () =>
    sseResponse([
      sse('response.output_text.delta', { delta: 'Hal' }),
      sse('response.output_text.delta', { delta: 'lo!' }),
      sse('response.reasoning_text.delta', { delta: 'denke…' }),
      sse('response.completed', {
        response: { usage: { input_tokens: 12, output_tokens: 5 } },
      }),
      'data: [DONE]\n\n',
    ])
  );
  const sink = collectCallbacks();

  const res = await openai.streamChatRound({
    config: CONFIG,
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.message.content, 'Hallo!');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { prompt: 12, completion: 5, total: 17 });
  assert.deepEqual(sink.textDeltas, ['Hal', 'lo!']);
  assert.deepEqual(sink.reasoningDeltas, ['denke…']);

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'gpt-4o');
  assert.equal(body.stream, true);
  assert.deepEqual(body.input, [{ role: 'user', content: 'Hi' }]);
  assert.ok(calls[0].url.endsWith('/responses'));
});

test('streamChatRound collects function calls and reports tool_calls finish reason', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      sse('response.output_item.added', { output_index: 0, item: { type: 'function_call', name: 'list_directory' } }),
      sse('response.function_call_arguments.delta', { output_index: 0, delta: '{"relative_' }),
      sse('response.function_call_arguments.delta', { output_index: 0, delta: 'path":"."}' }),
      sse('response.output_item.done', {
        item: { type: 'function_call', call_id: 'call_1', name: 'list_directory', arguments: '{"relative_path":"."}' },
      }),
      sse('response.completed', { response: {} }),
    ])
  );
  const sink = collectCallbacks();

  const res = await openai.streamChatRound({
    config: CONFIG,
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'ls' }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.message.content, null);
  assert.deepEqual(res.message.tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'list_directory', arguments: '{"relative_path":"."}' },
    },
  ]);
  assert.equal(sink.markGeneratingCalls, 1);
  assert.deepEqual(sink.toolCallStarts, [{ index: 0, name: 'list_directory' }]);
  assert.deepEqual(sink.toolCallArgumentDeltas, [
    { index: 0, delta: '{"relative_' },
    { index: 0, delta: 'path":"."}' },
  ]);
});

test('streamChatRound translates history with tool calls into Responses input items', async (t) => {
  const calls = mockFetch(t, () => sseResponse([sse('response.completed', { response: {} })]));
  const sink = collectCallbacks();

  await openai.streamChatRound({
    config: CONFIG,
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Du bist hilfreich.' },
      { role: 'user', content: 'ls' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'list_directory', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"items":[]}' },
    ],
    tools: [
      { type: 'function', function: { name: 'list_directory', description: 'ls', parameters: { type: 'object' } } },
    ],
    callbacks: sink.callbacks,
  });

  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.input, [
    { role: 'system', content: 'Du bist hilfreich.' },
    { role: 'user', content: 'ls' },
    { type: 'function_call', call_id: 'call_1', name: 'list_directory', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"items":[]}' },
  ]);
  assert.deepEqual(body.tools, [
    { type: 'function', name: 'list_directory', description: 'ls', parameters: { type: 'object' } },
  ]);
  assert.equal(body.tool_choice, 'auto');
});

test('streamChatRound surfaces stream errors as API errors', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      sse('response.output_text.delta', { delta: 'teil' }),
      sse('error', { error: { message: 'Kontingent erschöpft' } }),
    ])
  );
  const sink = collectCallbacks();

  const res = await openai.streamChatRound({
    config: CONFIG,
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });
  assert.deepEqual(res, { error: 'Kontingent erschöpft', code: 'API' });
});

test('streamChatRound maps HTTP errors and network failures', async (t) => {
  mockFetch(t, () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ error: { message: 'Invalid API key' } }),
  }));
  const sink = collectCallbacks();
  const res = await openai.streamChatRound({
    config: CONFIG,
    model: 'gpt-4o',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.deepEqual(res, { error: 'Invalid API key', code: '401' });

  mockFetch(t, () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  });
  const res2 = await openai.streamChatRound({
    config: CONFIG,
    model: 'gpt-4o',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.equal(res2.code, 'NETWORK');
  assert.match(res2.error, /ECONNREFUSED/);
});

test('streamChatRound returns the partial text when aborted mid-stream', async (t) => {
  const controller = new AbortController();
  mockFetch(t, () =>
    sseResponse([
      sse('response.output_text.delta', { delta: 'Teilantwort' }),
      sse('response.output_text.delta', { delta: ' bleibt' }),
    ])
  );
  const sink = collectCallbacks();
  sink.callbacks.onTextDelta = (d) => {
    sink.textDeltas.push(d);
    controller.abort();
  };

  const res = await openai.streamChatRound({
    config: CONFIG,
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
    abortSignal: controller.signal,
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.message.content, 'Teilantwort');
});

test('streamChatRound ignores malformed JSON data lines', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      'event: response.output_text.delta\ndata: {not json}\n\n',
      sse('response.output_text.delta', { delta: 'ok' }),
      sse('response.completed', { response: {} }),
    ])
  );
  const sink = collectCallbacks();
  const res = await openai.streamChatRound({
    config: CONFIG,
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });
  assert.equal(res.message.content, 'ok');
});
