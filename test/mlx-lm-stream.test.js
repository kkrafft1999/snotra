const test = require('node:test');
const assert = require('node:assert/strict');
const mlx = require('../src/main/providers/mlx-lm');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');

const CONFIG = { baseUrl: 'http://127.0.0.1:8080/v1' };

function chunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function deltaChunk(delta, finishReason = null) {
  return chunk({ choices: [{ delta, finish_reason: finishReason }] });
}

test('streamChatRound translates history into Chat-Completions messages', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']));
  const sink = collectCallbacks();

  await mlx.streamChatRound({
    config: CONFIG,
    model: 'mlx-community/test',
    messages: [
      { role: 'system', content: 'Sei knapp.' },
      { role: 'user', content: 'ls' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'list_directory', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: { items: [] } },
      { role: 'assistant', content: 'fertig' },
    ],
    tools: [
      { type: 'function', function: { name: 'list_directory' } },
      { type: 'function', function: {} },
    ],
    callbacks: sink.callbacks,
  });

  const body = JSON.parse(calls[0].options.body);
  assert.ok(calls[0].url.endsWith('/chat/completions'));
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Sei knapp.' },
    { role: 'user', content: 'ls' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'list_directory', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"items":[]}' },
    { role: 'assistant', content: 'fertig' },
  ]);
  assert.equal(body.tools.length, 1, 'tools without a function name must be dropped');
  assert.deepEqual(body.tools[0].function.parameters, { type: 'object', properties: {} });
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('streamChatRound assembles tool calls from split deltas', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      deltaChunk({
        tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_' } }],
      }),
      deltaChunk({
        tool_calls: [{ index: 0, function: { name: 'file_text', arguments: '{"relative_' } }],
      }),
      deltaChunk({
        tool_calls: [{ index: 0, function: { arguments: 'path":"a.txt"}' } }],
      }, 'tool_calls'),
      'data: [DONE]\n\n',
    ])
  );
  const sink = collectCallbacks();

  const res = await mlx.streamChatRound({
    config: CONFIG,
    model: 'm',
    messages: [{ role: 'user', content: 'lies a.txt' }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.finishReason, 'tool_calls');
  assert.deepEqual(res.message.tool_calls, [
    {
      id: 'call_a',
      type: 'function',
      function: { name: 'read_file_text', arguments: '{"relative_path":"a.txt"}' },
    },
  ]);
  assert.ok(sink.markGeneratingCalls >= 1);
  // Gemeldet wird erst mit dem ersten Argument-Stück — dann ist der gestückelte Name komplett.
  assert.deepEqual(sink.toolCallStarts, [{ index: 0, name: 'read_file_text' }]);
  assert.deepEqual(sink.toolCallArgumentDeltas, [
    { index: 0, delta: '{"relative_' },
    { index: 0, delta: 'path":"a.txt"}' },
  ]);
});

test('streamChatRound synthesizes ids for tool-call deltas without one and drops nameless calls', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      deltaChunk({ tool_calls: [{ index: 0, function: { name: 'list_directory', arguments: '{}' } }] }),
      deltaChunk({ tool_calls: [{ index: 1, function: { arguments: '{"orphan":true}' } }] }, 'tool_calls'),
    ])
  );
  const sink = collectCallbacks();

  const res = await mlx.streamChatRound({
    config: CONFIG,
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.message.tool_calls.length, 1, 'tool calls without a name must be filtered out');
  const call = res.message.tool_calls[0];
  assert.equal(call.function.name, 'list_directory');
  assert.match(call.id, /^mlx_call_0_/, 'missing ids must be synthesized');
});

test('streamChatRound collects text, usage and finish reason', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      deltaChunk({ content: 'Hal' }),
      deltaChunk({ content: 'lo' }, 'stop'),
      chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      'data: [DONE]\n\n',
    ])
  );
  const sink = collectCallbacks();

  const res = await mlx.streamChatRound({
    config: CONFIG,
    model: 'm',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.message.content, 'Hallo');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { prompt: 7, completion: 3, total: 10 });
  assert.deepEqual(sink.textDeltas, ['Hal', 'lo']);
});

test('streamChatRound surfaces in-stream errors as API errors', async (t) => {
  mockFetch(t, () => sseResponse([chunk({ error: { message: 'Modell nicht geladen' } })]));
  const sink = collectCallbacks();
  const res = await mlx.streamChatRound({
    config: CONFIG,
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.deepEqual(res, { error: 'Modell nicht geladen', code: 'API' });
});

test('streamChatRound maps connection failures to NETWORK errors', async (t) => {
  mockFetch(t, () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8080' };
    throw err;
  });
  const sink = collectCallbacks();
  const res = await mlx.streamChatRound({
    config: CONFIG,
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.equal(res.code, 'NETWORK');
  assert.match(res.error, /ECONNREFUSED/);
});

test('streamChatRound keeps complete tool calls when aborted mid-stream', async (t) => {
  const controller = new AbortController();
  mockFetch(t, () =>
    sseResponse([
      deltaChunk({
        tool_calls: [{ index: 0, id: 'call_a', function: { name: 'list_directory', arguments: '{}' } }],
      }),
      deltaChunk({ content: 'nie gesehen' }),
    ])
  );
  const sink = collectCallbacks();
  sink.callbacks.onMarkGenerating = () => controller.abort();

  const res = await mlx.streamChatRound({
    config: CONFIG,
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    callbacks: sink.callbacks,
    abortSignal: controller.signal,
  });

  assert.equal(res.cancelled, true);
  assert.deepEqual(res.message.tool_calls.map((c) => c.id), ['call_a']);
});
