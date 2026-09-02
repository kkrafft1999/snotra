const test = require('node:test');
const assert = require('node:assert/strict');
const anthropic = require('../src/main/providers/anthropic');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');

const CONFIG = { apiKey: 'sk-ant-test' };

function sse(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

test('streamChatRound requires an API key', async () => {
  const res = await anthropic.streamChatRound({ config: {}, model: 'claude-sonnet-4-6', messages: [] });
  assert.equal(res.error, 'Kein API-Key hinterlegt.');
  assert.equal(res.code, 'NO_API_KEY');
});

test('streamChatRound accumulates text deltas, usage and maps end_turn to stop', async (t) => {
  const calls = mockFetch(t, () =>
    sseResponse([
      sse('message_start', { message: { usage: { input_tokens: 20, output_tokens: 0 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hal' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo!' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
      sse('message_stop', {}),
    ])
  );
  const sink = collectCallbacks();

  const res = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.message.content, 'Hallo!');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { prompt: 20, completion: 5, total: 25 });
  assert.deepEqual(sink.textDeltas, ['Hal', 'lo!']);

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }]);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.headers['x-api-key'], 'sk-ant-test');
});

test('streamChatRound assembles streamed tool_use input and maps tool_use to tool_calls', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_directory' },
      }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"relative_' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'path":"."}' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
      sse('message_stop', {}),
    ])
  );
  const sink = collectCallbacks();

  const res = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'ls' }],
    tools: [{ type: 'function', function: { name: 'list_directory', parameters: { type: 'object' } } }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.message.content, null);
  assert.deepEqual(res.message.tool_calls, [
    {
      id: 'toolu_1',
      type: 'function',
      function: { name: 'list_directory', arguments: '{"relative_path":"."}' },
    },
  ]);
  assert.ok(sink.markGeneratingCalls >= 1);
  // Der gestreamte Aufruf wird sofort gemeldet — Grundlage für die vorläufige Tool-Zeile.
  assert.deepEqual(sink.toolCallStarts, [{ index: 0, name: 'list_directory' }]);
  assert.deepEqual(sink.toolCallArgumentDeltas, [
    { index: 0, delta: '{"relative_' },
    { index: 0, delta: 'path":"."}' },
  ]);
});

test('streamChatRound falls back to "{}" for unparseable streamed tool input', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_2', name: 'debug_wait' },
      }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'not valid json' } }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
    ])
  );
  const sink = collectCallbacks();

  const res = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'wait' }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.message.tool_calls[0].function.arguments, '{}');
});

test('streamChatRound forwards thinking deltas as reasoning', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      sse('content_block_start', { index: 0, content_block: { type: 'thinking' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'überlege…' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    ])
  );
  const sink = collectCallbacks();

  const res = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });

  assert.deepEqual(sink.reasoningDeltas, ['überlege…']);
  assert.equal(res.message.content, '');
});

test('streamChatRound surfaces in-stream error events as API errors', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'teil' } }),
      sse('error', { error: { message: 'Kontingent erschöpft' } }),
    ])
  );
  const sink = collectCallbacks();

  const res = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
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
    text: async () => JSON.stringify({ error: { message: 'invalid x-api-key' } }),
  }));
  const sink = collectCallbacks();
  const res = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.deepEqual(res, { error: 'invalid x-api-key', code: '401' });

  mockFetch(t, () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ENOTFOUND' };
    throw err;
  });
  const res2 = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.equal(res2.code, 'NETWORK');
  assert.match(res2.error, /ENOTFOUND/);
});

test('streamChatRound returns the partial text when aborted mid-stream', async (t) => {
  const controller = new AbortController();
  mockFetch(t, () =>
    sseResponse([
      sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Teilantwort' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' bleibt' } }),
    ])
  );
  const sink = collectCallbacks();
  sink.callbacks.onTextDelta = (d) => {
    sink.textDeltas.push(d);
    controller.abort();
  };

  const res = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
    abortSignal: controller.signal,
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.message.content, 'Teilantwort');
});

test('streamChatRound preserves a partial streamed tool call when aborted mid-stream', async (t) => {
  const controller = new AbortController();
  mockFetch(t, () =>
    sseResponse([
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_3', name: 'read_file_text' },
      }),
      sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"relative_path":"a.txt"}' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'nie gesehen' } }),
    ])
  );
  const sink = collectCallbacks();
  sink.callbacks.onMarkGenerating = () => controller.abort();

  const res = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'lies a.txt' }],
    callbacks: sink.callbacks,
    abortSignal: controller.signal,
  });

  assert.equal(res.cancelled, true);
  assert.deepEqual(res.message.tool_calls, [
    {
      id: 'toolu_3',
      type: 'function',
      function: { name: 'read_file_text', arguments: '{"relative_path":"a.txt"}' },
    },
  ]);
});

test('streamChatRound ignores malformed JSON data lines', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      'event: content_block_delta\ndata: {not json}\n\n',
      sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    ])
  );
  const sink = collectCallbacks();
  const res = await anthropic.streamChatRound({
    config: CONFIG,
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });
  assert.equal(res.message.content, 'ok');
});
