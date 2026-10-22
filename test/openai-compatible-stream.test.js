const test = require('node:test');
const assert = require('node:assert/strict');
const compat = require('../src/main/providers/openai-compatible');
const { isLocalEndpoint } = require('../src/shared/contracts/provider-endpoint');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');

const LOCAL = { baseUrl: 'http://localhost:1234/v1' };
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const REMOTE = { baseUrl: 'https://gw.intern.example/v1', apiKey: 'sk-gw' };

function chunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function deltaChunk(delta, finishReason = null) {
  return chunk({ choices: [{ delta, finish_reason: finishReason }] });
}

function responsesEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function statusResponse(status, body = '') {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    body: null,
    text: async () => body,
    json: async () => ({}),
  };
}

test.afterEach(() => {
  // Der Rueckfall auf Chat Completions merkt sich die Base-URL fuer die
  // Sitzung; ohne Aufraeumen faerbte ein Test auf den naechsten ab.
  compat.dispose();
});

// --- Header ----------------------------------------------------------------

test('ohne API-Key geht kein Authorization-Header hinaus', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']));
  const sink = collectCallbacks();

  await compat.streamChatRound({
    config: LOCAL,
    model: 'qwen2.5',
    messages: [{ role: 'user', content: 'hi' }],
    callbacks: sink.callbacks,
  });

  const headers = calls[0].options.headers;
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal('Authorization' in headers, false);
  assert.equal(calls[0].url, 'http://localhost:1234/v1/chat/completions');
});

test('ein gesetzter Key wird als Bearer geschickt', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop')]));
  const sink = collectCallbacks();

  await compat.streamChatRound({
    config: { ...LOCAL, apiKey: '  sk-local  ' },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });

  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-local');
});

test('parseExtraHeaders nimmt gueltige Zeilen und uebergeht den Rest', () => {
  const parsed = compat.parseExtraHeaders(
    [
      'X-Tenant: acme',
      '  X-Project:  snotra  ',
      '# Kommentar: nicht uebernehmen',
      'ohne Doppelpunkt',
      ': ohne Namen',
      'Bad Name: x',
      'Host: evil.example',
      'Content-Type: text/plain',
    ].join('\n')
  );
  assert.deepEqual(parsed, { 'X-Tenant': 'acme', 'X-Project': 'snotra' });
});

test('Zusatz-Header landen unveraendert im Request und duerfen Bearer ersetzen', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop')]));
  const sink = collectCallbacks();

  await compat.streamChatRound({
    config: {
      ...REMOTE,
      extraHeaders: 'X-Gateway-Token: geheim-123\nAuthorization: Token abc',
    },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });

  const headers = calls[0].options.headers;
  assert.equal(headers['X-Gateway-Token'], 'geheim-123');
  assert.equal(headers.Authorization, 'Token abc');
});

test('ein Header-Wert mit Steuerzeichen wird verworfen (Header-Injection)', () => {
  const parsed = compat.parseExtraHeaders('X-Evil: a\rX-Injected: b');
  assert.deepEqual(parsed, {});
});

test('eine HTTP-Fehlermeldung traegt keine Header weiter', async (t) => {
  mockFetch(t, () => statusResponse(401, JSON.stringify({ error: { message: 'Unauthorized' } })));
  const sink = collectCallbacks();

  const res = await compat.streamChatRound({
    config: { ...REMOTE, extraHeaders: 'X-Gateway-Token: geheim-123' },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });

  assert.equal(res.code, '401');
  assert.equal(res.error, 'Unauthorized');
  assert.doesNotMatch(JSON.stringify(res), /geheim-123|X-Gateway-Token/);
});

// --- Chat-Completions-Transport -------------------------------------------

test('streamChatRound sammelt Text, Usage und finish_reason', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      deltaChunk({ content: 'Hal' }),
      deltaChunk({ content: 'lo' }, 'stop'),
      chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
      'data: [DONE]\n\n',
    ])
  );
  const sink = collectCallbacks();

  const res = await compat.streamChatRound({
    config: LOCAL,
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    callbacks: sink.callbacks,
  });

  assert.equal(res.message.content, 'Hallo');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { prompt: 7, completion: 3, total: 10, cached: 0 });
  assert.deepEqual(sink.textDeltas, ['Hal', 'lo']);
});

test('ohne Usage des Servers bleibt usage null statt 0', async (t) => {
  mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']));
  const sink = collectCallbacks();

  const res = await compat.streamChatRound({
    config: LOCAL,
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });

  assert.equal(res.usage, null);
});

test('stream_options.include_usage geht immer mit', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop')]));
  const sink = collectCallbacks();

  await compat.streamChatRound({ config: LOCAL, model: 'm', messages: [], callbacks: sink.callbacks });

  assert.deepEqual(JSON.parse(calls[0].options.body).stream_options, { include_usage: true });
});

test('Tool-Deltas werden zusammengesetzt und gemeldet', async (t) => {
  mockFetch(t, () =>
    sseResponse([
      deltaChunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_' } }] }),
      deltaChunk({ tool_calls: [{ index: 0, function: { name: 'directory' } }] }),
      deltaChunk({ tool_calls: [{ index: 0, function: { arguments: '{"relative_path"' } }] }),
      deltaChunk({ tool_calls: [{ index: 0, function: { arguments: ':"."}' } }] }, 'tool_calls'),
      'data: [DONE]\n\n',
    ])
  );
  const sink = collectCallbacks();

  const res = await compat.streamChatRound({
    config: LOCAL,
    model: 'm',
    messages: [],
    tools: [{ type: 'function', function: { name: 'list_directory' } }],
    callbacks: sink.callbacks,
  });

  assert.deepEqual(res.message.tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'list_directory', arguments: '{"relative_path":"."}' },
    },
  ]);
  assert.equal(res.finishReason, 'tool_calls');
  assert.deepEqual(sink.toolCallStarts, [{ index: 0, name: 'list_directory' }]);
  assert.deepEqual(
    sink.toolCallArgumentDeltas.map((d) => d.delta),
    ['{"relative_path"', ':"."}']
  );
});

test('sendTools: false laesst das Feld tools weg', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop')]));
  const sink = collectCallbacks();
  const tools = [{ type: 'function', function: { name: 'list_directory' } }];

  await compat.streamChatRound({
    config: { ...LOCAL, sendTools: false },
    model: 'm',
    messages: [],
    tools,
    callbacks: sink.callbacks,
  });
  const withoutTools = JSON.parse(calls[0].options.body);
  assert.equal('tools' in withoutTools, false);
  assert.equal('tool_choice' in withoutTools, false);

  await compat.streamChatRound({
    config: LOCAL,
    model: 'm',
    messages: [],
    tools,
    callbacks: sink.callbacks,
  });
  const withTools = JSON.parse(calls[1].options.body);
  assert.equal(withTools.tools.length, 1);
  assert.equal(withTools.tool_choice, 'auto');
});

test('Bilder gehen nur bei supportsImages als image_url mit', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop')]));
  const sink = collectCallbacks();
  const messages = [
    {
      role: 'user',
      content: 'Was steht da?',
      attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX }],
    },
  ];

  await compat.streamChatRound({ config: LOCAL, model: 'm', messages, callbacks: sink.callbacks });
  assert.deepEqual(JSON.parse(calls[0].options.body).messages, [
    { role: 'user', content: 'Was steht da?' },
  ]);

  await compat.streamChatRound({
    config: { ...LOCAL, supportsImages: true },
    model: 'm',
    messages,
    callbacks: sink.callbacks,
  });
  assert.deepEqual(JSON.parse(calls[1].options.body).messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Was steht da?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1PX}` } },
      ],
    },
  ]);
});

test('images follow the supportsImages switch of the entry (#996)', () => {
  const { resolveProviderCapabilities } = require('../src/shared/contracts/provider-capabilities');
  assert.equal(resolveProviderCapabilities(compat, {}).images, false);
  assert.equal(resolveProviderCapabilities(compat, { supportsImages: true }).images, true);
});

test('ein Verbindungsfehler wird zu NETWORK', async (t) => {
  mockFetch(t, () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1234' };
    throw err;
  });
  const sink = collectCallbacks();

  const res = await compat.streamChatRound({
    config: LOCAL,
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.equal(res.code, 'NETWORK');
  assert.match(res.error, /ECONNREFUSED/);
});

test('ein Fehler im Stream wird als API-Fehler gemeldet', async (t) => {
  mockFetch(t, () => sseResponse([chunk({ error: { message: 'Modell nicht geladen' } }), 'data: [DONE]\n\n']));
  const sink = collectCallbacks();

  const res = await compat.streamChatRound({
    config: LOCAL,
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.deepEqual(res, { error: 'Modell nicht geladen', code: 'API' });
});

test('Abbruch behaelt vollstaendige Tool-Aufrufe', async (t) => {
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

  const res = await compat.streamChatRound({
    config: LOCAL,
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    callbacks: sink.callbacks,
    abortSignal: controller.signal,
  });

  assert.equal(res.cancelled, true);
  assert.deepEqual(res.message.tool_calls.map((c) => c.id), ['call_a']);
});

// --- API-Stil und Rueckfall ------------------------------------------------

test('apiStyle chat fasst /responses nie an', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop')]));
  const sink = collectCallbacks();

  await compat.streamChatRound({
    config: { ...LOCAL, apiStyle: 'chat' },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/chat/completions'));
});

test('apiStyle full spricht /responses', async (t) => {
  const calls = mockFetch(t, () =>
    sseResponse([
      responsesEvent('response.output_text.delta', { delta: 'Hallo' }),
      responsesEvent('response.completed', {
        response: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
      }),
    ])
  );
  const sink = collectCallbacks();

  const res = await compat.streamChatRound({
    config: { ...REMOTE, apiStyle: 'full' },
    model: 'm',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: sink.callbacks,
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/responses'));
  assert.equal(res.message.content, 'Hallo');
  assert.deepEqual(res.usage, { prompt: 4, completion: 2, total: 6, cached: 0 });
  assert.equal('status' in res, false, 'die interne Weiche gehoert nicht ins Ergebnis');
});

for (const status of [404, 405]) {
  test(`apiStyle full faellt bei ${status} genau einmal auf Chat Completions zurueck`, async (t) => {
    const calls = mockFetch(t, (url) =>
      url.endsWith('/responses')
        ? statusResponse(status)
        : sseResponse([deltaChunk({ content: 'ok' }, 'stop')])
    );
    const sink = collectCallbacks();

    const first = await compat.streamChatRound({
      config: { ...REMOTE, apiStyle: 'full' },
      model: 'm',
      messages: [],
      callbacks: sink.callbacks,
    });
    assert.equal(first.message.content, 'ok');
    assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ['/v1/responses', '/v1/chat/completions']);

    // Zweite Runde: der Stil steht fest, /responses wird nicht erneut probiert.
    await compat.streamChatRound({
      config: { ...REMOTE, apiStyle: 'full' },
      model: 'm',
      messages: [],
      callbacks: sink.callbacks,
    });
    assert.deepEqual(calls.map((c) => new URL(c.url).pathname), [
      '/v1/responses',
      '/v1/chat/completions',
      '/v1/chat/completions',
    ]);
  });
}

test('ein anderer Fehlerstatus loest keinen Rueckfall aus', async (t) => {
  const calls = mockFetch(t, () => statusResponse(500, JSON.stringify({ error: { message: 'Bumm' } })));
  const sink = collectCallbacks();

  const res = await compat.streamChatRound({
    config: { ...REMOTE, apiStyle: 'full' },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(res, { error: 'Bumm', code: '500' });
});

// --- Reasoning levels (#1148) ----------------------------------------------

test('reasoning_effort goes out only when the entry says its server takes it', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop')]));
  const sink = collectCallbacks();
  const round = (config) => compat.streamChatRound({ config, model: 'gpt-oss-20b', messages: [], callbacks: sink.callbacks });

  await round({ ...LOCAL, supportsReasoning: true, reasoningEffort: 'high' });
  assert.equal(JSON.parse(calls[0].options.body).reasoning_effort, 'high');

  // Switch off: the chat's level stays at home, the server never sees the field.
  await round({ ...LOCAL, reasoningEffort: 'high' });
  assert.equal('reasoning_effort' in JSON.parse(calls[1].options.body), false);

  // Switch on without a level, or with one the entry does not offer: nothing.
  await round({ ...LOCAL, supportsReasoning: true });
  await round({ ...LOCAL, supportsReasoning: true, reasoningEffort: 'xhigh' });
  assert.equal('reasoning_effort' in JSON.parse(calls[2].options.body), false);
  assert.equal('reasoning_effort' in JSON.parse(calls[3].options.body), false);
});

test('the Responses style sends the level as reasoning.effort, and the fallback as reasoning_effort', async (t) => {
  const calls = mockFetch(t, (url) =>
    url.endsWith('/responses')
      ? statusResponse(404)
      : sseResponse([deltaChunk({ content: 'ok' }, 'stop')])
  );
  const sink = collectCallbacks();
  await compat.streamChatRound({
    config: { ...REMOTE, apiStyle: 'full', supportsReasoning: true, reasoningEffort: 'low' },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });
  const [responses, chat] = calls.map((c) => JSON.parse(c.options.body));
  assert.deepEqual(responses.reasoning, { effort: 'low' });
  assert.equal('reasoning_effort' in responses, false);
  assert.equal(chat.reasoning_effort, 'low');
  assert.equal('reasoning' in chat, false);
});

test('a level the server turns down is explained, with its own words kept', async (t) => {
  mockFetch(t, () => statusResponse(400, JSON.stringify({
    error: { message: "Invalid value for 'reasoning_effort': 'high'." },
  })));
  const sink = collectCallbacks();
  const res = await compat.streamChatRound({
    config: { ...LOCAL, supportsReasoning: true, reasoningEffort: 'high' },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.equal(res.code, '400');
  assert.deepEqual(res.error, {
    key: 'provider.compatible.error.effortRejected',
    params: { effort: 'high', detail: "Invalid value for 'reasoning_effort': 'high'." },
  });
});

test('a rejection about something else, or without a level sent, keeps the server text', async (t) => {
  const answers = ['context length exceeded', 'unknown field reasoning_effort'];
  mockFetch(t, () => statusResponse(400, JSON.stringify({ error: { message: answers.shift() } })));
  const sink = collectCallbacks();
  const other = await compat.streamChatRound({
    config: { ...LOCAL, supportsReasoning: true, reasoningEffort: 'high' },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.equal(other.error, 'context length exceeded');

  const unsent = await compat.streamChatRound({
    config: { ...LOCAL, reasoningEffort: 'high' },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });
  assert.equal(unsent.error, 'unknown field reasoning_effort');
});

test('reasoning levels follow the supportsReasoning switch of the entry (#1148)', () => {
  assert.deepEqual(compat.capabilities.reasoningLevels, {
    supported: 'per-connection',
    setting: 'supportsReasoning',
    reason: 'provider.compatible.reasoning.connectionOff',
  });
  assert.deepEqual([...compat.reasoning.levels], ['low', 'medium', 'high']);
  assert.equal(compat.fields.supportsReasoning, true);
});

// --- Modellliste -----------------------------------------------------------

test('listModels liefert die sortierte Liste mit Key und Zusatz-Headern', async (t) => {
  const calls = mockFetch(t, () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [{ id: 'zeta' }, { id: 'alpha' }, { nope: true }] }),
    text: async () => '',
  }));

  const res = await compat.listModels({ ...REMOTE, extraHeaders: 'X-Tenant: acme' });

  assert.deepEqual(res.models, [
    { id: 'alpha', label: 'alpha' },
    { id: 'zeta', label: 'zeta' },
  ]);
  assert.equal(calls[0].url, 'https://gw.intern.example/v1/models');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-gw');
  assert.equal(calls[0].options.headers['X-Tenant'], 'acme');
  assert.equal('Content-Type' in calls[0].options.headers, false, 'GET braucht keinen Body-Typ');
});

test('listModels ohne Key schickt keinen Authorization-Header', async (t) => {
  const calls = mockFetch(t, () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data: [] }),
    text: async () => '',
  }));

  const res = await compat.listModels(LOCAL);

  assert.deepEqual(res.models, []);
  assert.equal('Authorization' in calls[0].options.headers, false);
});

test('listModels meldet einen nicht erreichbaren Server als Fehlertext', async (t) => {
  mockFetch(t, () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1234' };
    throw err;
  });

  const res = await compat.listModels(LOCAL);
  assert.ok(res.error);
  assert.equal(res.models, undefined);
});

// --- Base-URL --------------------------------------------------------------

test('ein Schraegstrich am Ende der Base-URL wird abgeschnitten', async (t) => {
  const calls = mockFetch(t, () => sseResponse([deltaChunk({ content: 'ok' }, 'stop')]));
  const sink = collectCallbacks();

  await compat.streamChatRound({
    config: { baseUrl: 'http://localhost:1234/v1/' },
    model: 'm',
    messages: [],
    callbacks: sink.callbacks,
  });

  assert.equal(calls[0].url, 'http://localhost:1234/v1/chat/completions');
});

test('die Vorlagen decken die im Issue genannten Ziele ab', () => {
  const ids = compat.TEMPLATES.map((t) => t.id);
  assert.deepEqual(ids, ['lm-studio', 'mlx-lm', 'llama-cpp', 'vllm', 'ollama', 'openrouter', 'custom']);
  // Lokale Vorlagen muessen auch als lokal erkannt werden — daran haengen
  // Zeitlimit, Verlaufsbudget und Token-Teiler.
  for (const id of ['lm-studio', 'mlx-lm', 'llama-cpp', 'vllm', 'ollama']) {
    const template = compat.TEMPLATES.find((t) => t.id === id);
    assert.equal(isLocalEndpoint(template.baseUrl), true, `${id} sollte lokal sein`);
  }
  assert.equal(isLocalEndpoint(compat.TEMPLATES.find((t) => t.id === 'openrouter').baseUrl), false);
});

test('an extra header replaces a built one in any spelling (#541)', () => {
  const headers = compat.buildHeaders({ apiKey: 'sk-1', extraHeaders: 'authorization: Basic abc\nx-a: 1\nX-A: 2' });
  assert.equal(new Headers(headers).get('authorization'), 'Basic abc', 'the key does not go along');
  assert.equal(new Headers(headers).get('x-a'), '2', 'the last of two spellings wins');
  assert.equal(Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization').length, 1);
});
