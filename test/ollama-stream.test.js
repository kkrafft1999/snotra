const test = require('node:test');
const assert = require('node:assert/strict');
const ollama = require('../src/main/providers/ollama');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');

const CONFIG = { baseUrl: 'http://localhost:11434' };

function line(payload) {
  return `${JSON.stringify(payload)}\n`;
}

test.after(() => {
  // Undici-Agent (falls durch den insecureTls-Test erzeugt) nicht offen lassen.
  ollama.destroyInsecureDispatcher();
});

test('streamChatRound accumulates streamed text and reports usage from the final line', async (t) => {
  const calls = mockFetch(t, () =>
    sseResponse([
      line({ message: { role: 'assistant', content: 'Hal' }, done: false }),
      line({ message: { role: 'assistant', content: 'lo!' }, done: false }),
      line({ done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 5 }),
    ])
  );
  const sink = collectCallbacks();

  const res = await ollama.streamChatRound({
    config: CONFIG,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.message.content, 'Hallo!');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { prompt: 12, completion: 5, total: 17, cached: 0 });
  assert.deepEqual(sink.textDeltas, ['Hal', 'lo!']);

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'llama3.2');
  assert.equal(body.stream, true);
  assert.equal(calls[0].url, 'http://localhost:11434/api/chat');
});

test('streamChatRound collects tool calls and reports the tool_calls finish reason', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      line({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'list_directory', arguments: { relative_path: '.' } } }],
        },
        done: false,
      }),
      line({ done: true }),
    ])
  );
  const sink = collectCallbacks();

  const res = await ollama.streamChatRound({
    config: CONFIG,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'ls' }],
    tools: [{ type: 'function', function: { name: 'list_directory', description: 'ls', parameters: { type: 'object' } } }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.message.content, null);
  assert.equal(res.message.tool_calls.length, 1);
  assert.equal(res.message.tool_calls[0].function.name, 'list_directory');
  assert.deepEqual(JSON.parse(res.message.tool_calls[0].function.arguments), { relative_path: '.' });
  assert.ok(res.message.tool_calls[0].id.startsWith('ocall_'));
  assert.equal(sink.markGeneratingCalls, 1);
  // Ollama liefert den Aufruf komplett — die Meldung trägt die Argumente direkt.
  assert.deepEqual(sink.toolCallStarts, [{ index: 0, name: 'list_directory', args: { relative_path: '.' } }]);
});

test('streamChatRound sends the translated tools payload', async (t) => {
  const calls = mockFetch(t, () => sseResponse([line({ done: true })]));
  const sink = collectCallbacks();

  await ollama.streamChatRound({
    config: CONFIG,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'ls' }],
    tools: [{ type: 'function', function: { name: 'list_directory', description: 'ls', parameters: { type: 'object' } } }],
    callbacks: sink.callbacks,
  });

  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: { name: 'list_directory', description: 'ls', parameters: { type: 'object' } },
    },
  ]);
});

test('streamChatRound surfaces an in-stream error field as an API error', async (t) => {
  mockFetch(t, () => sseResponse([line({ error: 'model "llama3.2" not found' })]));
  const sink = collectCallbacks();

  const res = await ollama.streamChatRound({
    config: CONFIG,
    model: 'llama3.2',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.deepEqual(res, { error: 'model "llama3.2" not found', code: 'API' });
});

test('streamChatRound maps HTTP errors and network failures', async (t) => {
  mockFetch(t, () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    text: async () => JSON.stringify({ error: 'model not found' }),
  }));
  const sink = collectCallbacks();
  const res = await ollama.streamChatRound({
    config: CONFIG,
    model: 'llama3.2',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.deepEqual(res, { error: 'model not found', code: '404' });

  mockFetch(t, () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  });
  const res2 = await ollama.streamChatRound({
    config: CONFIG,
    model: 'llama3.2',
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
      line({ message: { role: 'assistant', content: 'Teilantwort' }, done: false }),
      line({ message: { role: 'assistant', content: ' bleibt' }, done: false }),
    ])
  );
  const sink = collectCallbacks();
  sink.callbacks.onTextDelta = (d) => {
    sink.textDeltas.push(d);
    controller.abort();
  };

  const res = await ollama.streamChatRound({
    config: CONFIG,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
    abortSignal: controller.signal,
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.message.content, 'Teilantwort');
});

test('streamChatRound preserves already-collected tool calls when aborted mid-stream', async (t) => {
  const controller = new AbortController();
  mockFetch(t, () =>
    sseResponse([
      line({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'list_directory', arguments: {} } }],
        },
        done: false,
      }),
      line({ message: { role: 'assistant', content: 'nie gesehen' }, done: false }),
    ])
  );
  const sink = collectCallbacks();
  sink.callbacks.onMarkGenerating = () => controller.abort();

  const res = await ollama.streamChatRound({
    config: CONFIG,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'x' }],
    callbacks: sink.callbacks,
    abortSignal: controller.signal,
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.message.tool_calls.length, 1);
  assert.equal(res.message.tool_calls[0].function.name, 'list_directory');
});

test('streamChatRound ignores malformed JSON and blank lines', async (t) => {
  mockFetch(t, () =>
    sseResponse(['\n', 'not json at all\n', line({ message: { role: 'assistant', content: 'ok' }, done: false }), line({ done: true })])
  );
  const sink = collectCallbacks();
  const res = await ollama.streamChatRound({
    config: CONFIG,
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });
  assert.equal(res.message.content, 'ok');
});

test('streamChatRound only attaches the insecure-TLS dispatcher for https URLs when enabled', async (t) => {
  const httpsCalls = mockFetch(t, () => sseResponse([line({ done: true })]));
  const sink = collectCallbacks();

  await ollama.streamChatRound({
    config: { baseUrl: 'https://ollama.intern.example', insecureTls: true },
    model: 'llama3.2',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.ok(httpsCalls[0].options.dispatcher, 'insecure https requests must use the custom dispatcher');

  const httpCalls = mockFetch(t, () => sseResponse([line({ done: true })]));
  await ollama.streamChatRound({
    config: { baseUrl: 'http://localhost:11434', insecureTls: true },
    model: 'llama3.2',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.equal(httpCalls[0].options.dispatcher, undefined, 'plain http must never use the dispatcher');

  const noFlagCalls = mockFetch(t, () => sseResponse([line({ done: true })]));
  await ollama.streamChatRound({
    config: { baseUrl: 'https://ollama.intern.example', insecureTls: false },
    model: 'llama3.2',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.equal(noFlagCalls[0].options.dispatcher, undefined, 'https without insecureTls must not use the dispatcher');
});

// Reasoning levels (#994).

const { reasoningLevelsFor, reasoningDefaultFor } = require('../src/shared/contracts/reasoning');

function thinkingAnswer() {
  return sseResponse([
    line({ message: { role: 'assistant', content: '', thinking: 'Let me ' }, done: false }),
    line({ message: { role: 'assistant', content: '', thinking: 'see.' }, done: false }),
    line({ message: { role: 'assistant', content: 'Here.' }, done: false }),
    line({ done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 }),
  ]);
}

test('gpt-oss offers levels, the other thinking models off and on, the rest none (#994)', () => {
  assert.deepEqual(reasoningLevelsFor(ollama, 'gpt-oss:20b'), ['low', 'medium', 'high']);
  assert.equal(reasoningDefaultFor(ollama, 'gpt-oss:20b'), 'medium');
  for (const model of ['qwen3:8b', 'qwen3', 'deepseek-r1:14b', 'magistral:24b', 'hf.co/unsloth/Qwen3-8B-GGUF']) {
    assert.deepEqual(reasoningLevelsFor(ollama, model), ['none', 'on'], model);
    assert.equal(reasoningDefaultFor(ollama, model), 'on', model);
  }
  for (const model of ['llama3.2', 'qwen2.5:7b', 'qwen3-coder:30b', 'qwen3:30b-a3b-instruct-2507', 'qwen3-embedding']) {
    assert.deepEqual(reasoningLevelsFor(ollama, model), [], model);
  }
});

test('the level goes out as think: a word for gpt-oss, true or false for the others (#994)', async (t) => {
  const calls = mockFetch(t, () => thinkingAnswer());
  for (const [model, reasoningEffort] of [
    ['gpt-oss:20b', 'high'],
    ['qwen3:8b', 'on'],
    ['qwen3:8b', 'none'],
    ['llama3.2', 'high'],
    ['gpt-oss:20b', 'on'],
  ]) {
    await ollama.streamChatRound({
      config: { ...CONFIG, reasoningEffort },
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      callbacks: collectCallbacks().callbacks,
    });
  }
  assert.deepEqual(calls.map((c) => JSON.parse(c.options.body).think), ['high', true, false, undefined, undefined]);
});

test('streamed thinking is reasoning, and goes back with the tool loop (#994)', async (t) => {
  mockFetch(t, () => thinkingAnswer());
  const sink = collectCallbacks();
  const res = await ollama.streamChatRound({
    config: { ...CONFIG, reasoningEffort: 'medium' },
    model: 'gpt-oss:20b',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });
  assert.deepEqual(sink.reasoningDeltas, ['Let me ', 'see.']);
  assert.deepEqual(sink.textDeltas, ['Here.']);
  assert.equal(res.message.content, 'Here.');
  assert.equal(res.message.ollamaThinking, 'Let me see.');

  const back = ollama.translateMessagesToOllama([{ role: 'user', content: 'Hi' }, res.message]);
  assert.deepEqual(back[1], { role: 'assistant', content: 'Here.', thinking: 'Let me see.' });
});

test('a model that does not think after all is asked again without think (#994)', async (t) => {
  let round = 0;
  const calls = mockFetch(t, () => {
    round += 1;
    if (round === 1) {
      return sseResponse([JSON.stringify({ error: '"qwen3-custom:latest" does not support thinking' })], { status: 400 });
    }
    return thinkingAnswer();
  });
  const res = await ollama.streamChatRound({
    config: { ...CONFIG, reasoningEffort: 'on' },
    model: 'qwen3-custom:latest',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: collectCallbacks().callbacks,
  });
  assert.equal(res.message.content, 'Here.');
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].options.body).think, true);
  assert.equal('think' in JSON.parse(calls[1].options.body), false);
});
