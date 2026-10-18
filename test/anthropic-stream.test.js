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
  assert.deepEqual(res.error, { key: 'provider.error.noApiKey' });
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
  assert.deepEqual(res.usage, { prompt: 20, completion: 5, total: 25, cached: 0 });
  assert.deepEqual(sink.textDeltas, ['Hal', 'lo!']);

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }]);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.headers['x-api-key'], 'sk-ant-test');
});

test('streamChatRound zaehlt die Cache-Anteile zum Prompt (#179)', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      // Anthropic nennt die Cache-Zahlen nur im message_start, und zwar NEBEN
      // input_tokens: der volle Prompt ist 500 + 9000 + 500.
      sse('message_start', {
        message: {
          usage: {
            input_tokens: 500,
            cache_read_input_tokens: 9000,
            cache_creation_input_tokens: 500,
            output_tokens: 0,
          },
        },
      }),
      sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }),
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

  // Das abschliessende message_delta wiederholt die Cache-Zahlen nicht — sie
  // duerfen dabei nicht verloren gehen.
  // The cache write stays a part of the prompt, and is named apart so that
  // it can be priced apart (#949).
  assert.deepEqual(res.usage, { prompt: 10000, completion: 20, total: 10020, cached: 9000, cacheWrite: 500 });
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
        content_block: { type: 'tool_use', id: 'toolu_2', name: 'web_search' },
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

test('an assistant turn stopped before its first token is left out (#540)', () => {
  const { messages } = anthropic.translateMessagesToAnthropic([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'again' },
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'q' },
    { role: 'user', content: 'again' },
  ]);
  assert.equal(JSON.stringify(messages).includes('"text":""'), false, 'no empty text block');
});

// Reasoning levels (#994).

const { reasoningLevelsFor, reasoningDefaultFor } = require('../src/shared/contracts/reasoning');

function thinkingRound() {
  return sseResponse([
    sse('message_start', { message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Look first.' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-A' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'opaque' } }),
    sse('content_block_stop', { index: 1 }),
    sse('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'list_directory' } }),
    sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }),
    sse('content_block_stop', { index: 2 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
    sse('message_stop', {}),
  ]);
}

function endTurn() {
  return sseResponse([
    sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop', {}),
  ]);
}

test('every Claude model that thinks offers the levels it takes (#994)', () => {
  const all = ['low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(reasoningLevelsFor(anthropic, 'claude-opus-5-5'), all);
  assert.deepEqual(reasoningLevelsFor(anthropic, 'claude-sonnet-5-5'), all);
  assert.deepEqual(reasoningLevelsFor(anthropic, 'claude-haiku-5-5'), all);
  assert.deepEqual(reasoningLevelsFor(anthropic, 'claude-fable-5-1'), all);
  assert.deepEqual(reasoningLevelsFor(anthropic, 'claude-opus-4-7'), all);
  // xhigh came with Opus 4.7.
  assert.deepEqual(reasoningLevelsFor(anthropic, 'claude-opus-4-6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(reasoningLevelsFor(anthropic, 'claude-sonnet-4-6'), ['low', 'medium', 'high', 'max']);
  // A thinking budget: three levels.
  for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-sonnet-4-20250514', 'claude-opus-4-1', 'claude-3-7-sonnet-latest']) {
    assert.deepEqual(reasoningLevelsFor(anthropic, model), ['low', 'medium', 'high'], model);
  }
  for (const model of ['claude-3-5-haiku-latest', 'claude-3-haiku-20240307', 'something-else', '']) {
    assert.deepEqual(reasoningLevelsFor(anthropic, model), [], model);
  }
  assert.equal(reasoningDefaultFor(anthropic, 'claude-opus-5-5'), 'medium');
});

test('an adaptive model gets adaptive thinking, summarised, with the effort (#994)', async (t) => {
  const calls = mockFetch(t, () => endTurn());
  await anthropic.streamChatRound({
    config: { ...CONFIG, reasoningEffort: 'xhigh' },
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: collectCallbacks().callbacks,
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'xhigh' });
  assert.equal(body.max_tokens, 32768);
});

test('Opus and Sonnet 4.6 summarise by default and get no display field (#994)', async (t) => {
  const calls = mockFetch(t, () => endTurn());
  await anthropic.streamChatRound({
    config: { ...CONFIG, reasoningEffort: 'low' },
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: collectCallbacks().callbacks,
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'low' });
});

test('an older model gets a thinking budget below max_tokens (#994)', async (t) => {
  const calls = mockFetch(t, () => endTurn());
  await anthropic.streamChatRound({
    config: { ...CONFIG, reasoningEffort: 'high' },
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: collectCallbacks().callbacks,
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 16384 });
  assert.ok(body.max_tokens > body.thinking.budget_tokens);
  assert.equal(body.output_config, undefined);
});

test('no level, or one the model does not take, sends no thinking at all (#994)', async (t) => {
  const calls = mockFetch(t, () => endTurn());
  for (const [model, reasoningEffort] of [
    ['claude-opus-5-5', undefined],
    ['claude-sonnet-4-6', 'xhigh'],
    ['claude-3-5-haiku-latest', 'high'],
  ]) {
    await anthropic.streamChatRound({
      config: { ...CONFIG, reasoningEffort },
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      callbacks: collectCallbacks().callbacks,
    });
  }
  for (const call of calls) {
    const body = JSON.parse(call.options.body);
    assert.equal(body.thinking, undefined);
    assert.equal(body.output_config, undefined);
    assert.equal(body.max_tokens, 8192);
  }
});

test('the thinking of a round travels with the turn and goes back unchanged (#994)', async (t) => {
  let round = 0;
  const calls = mockFetch(t, () => (round++ === 0 ? thinkingRound() : endTurn()));
  const config = { ...CONFIG, reasoningEffort: 'high' };
  const model = 'claude-opus-5-5';
  const history = [
    { role: 'user', content: 'Earlier question' },
    {
      role: 'assistant',
      content: 'Earlier answer',
      anthropicThinking: { model, blocks: [{ type: 'thinking', thinking: 'old', signature: 'sig-old' }] },
    },
    { role: 'user', content: 'What is here?' },
  ];
  const sink = collectCallbacks();
  const first = await anthropic.streamChatRound({ config, model, messages: history, callbacks: sink.callbacks });

  assert.deepEqual(sink.reasoningDeltas, ['Look first.']);
  assert.deepEqual(first.message.anthropicThinking, {
    model,
    blocks: [
      { type: 'thinking', thinking: 'Look first.', signature: 'sig-A' },
      { type: 'redacted_thinking', data: 'opaque' },
    ],
  });

  await anthropic.streamChatRound({
    config,
    model,
    messages: [...history, first.message, { role: 'tool', tool_call_id: 'tu_1', content: '{"entries":[]}' }],
    callbacks: collectCallbacks().callbacks,
  });
  const sent = JSON.parse(calls[1].options.body).messages;
  // An earlier turn goes without its thinking …
  assert.deepEqual(sent[1], { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] });
  // … the running one with it, in front of the call.
  assert.deepEqual(sent[3].content.map((b) => b.type), ['thinking', 'redacted_thinking', 'tool_use']);
  assert.deepEqual(sent[3].content[0], { type: 'thinking', thinking: 'Look first.', signature: 'sig-A' });
});

test('thinking from another model stays behind (#994)', () => {
  const { messages } = anthropic.translateMessagesToAnthropic([
    { role: 'user', content: 'Hi' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'x', arguments: '{}' } }],
      anthropicThinking: { model: 'claude-opus-5-5', blocks: [{ type: 'thinking', thinking: 't', signature: 's' }] },
    },
    { role: 'tool', tool_call_id: 'tu_1', content: 'ok' },
  ], { model: 'claude-sonnet-5-5' });
  assert.deepEqual(messages[1].content.map((b) => b.type), ['tool_use']);
});

test('a turn whose thinking no longer fits its history goes out once more without it (#994)', async (t) => {
  let round = 0;
  const calls = mockFetch(t, () => {
    round += 1;
    if (round === 1) {
      return sseResponse([JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
        },
      })], { status: 400 });
    }
    return endTurn();
  });
  const model = 'claude-opus-5-5';
  const res = await anthropic.streamChatRound({
    config: { ...CONFIG, reasoningEffort: 'medium' },
    model,
    messages: [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'x', arguments: '{}' } }],
        anthropicThinking: { model, blocks: [{ type: 'thinking', thinking: 't', signature: 's' }] },
      },
      { role: 'tool', tool_call_id: 'tu_1', content: '[output shortened]' },
    ],
    callbacks: collectCallbacks().callbacks,
  });
  assert.equal(res.message.content, 'Done.');
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body).messages[1].content.map((b) => b.type), ['thinking', 'tool_use']);
  assert.deepEqual(JSON.parse(calls[1].options.body).messages[1].content.map((b) => b.type), ['tool_use']);
});

test('any other 400 is reported, not retried (#994)', async (t) => {
  const calls = mockFetch(t, () => sseResponse([JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'max_tokens: too large' },
  })], { status: 400 }));
  const res = await anthropic.streamChatRound({
    config: { ...CONFIG, reasoningEffort: 'medium' },
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: collectCallbacks().callbacks,
  });
  assert.equal(res.error, 'max_tokens: too large');
  assert.equal(res.code, '400');
  assert.equal(calls.length, 1);
});
