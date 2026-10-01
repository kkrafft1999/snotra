const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAbortError,
  sleepAbortable,
  normalizeUsage,
  mergeUsage,
  describeFetchErrorMessage,
} = require('../src/main/providers/stream-helpers');
const { describeFetchError } = require('../src/shared/runtime/fetch-errors');

test('isAbortError recognizes AbortError', () => {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  assert.equal(isAbortError(err), true);
  assert.equal(isAbortError(new Error('other')), false);
});

test('sleepAbortable rejects when signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => sleepAbortable(50, controller.signal), (err) => isAbortError(err));
});

test('sleepAbortable rejects when aborted during wait', async () => {
  const controller = new AbortController();
  const pending = sleepAbortable(500, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending, (err) => isAbortError(err));
});

test('normalizeUsage maps provider-specific usage fields', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5 }), {
    prompt: 10,
    completion: 5,
    total: 15,
    cached: 0,
  });
  assert.deepEqual(normalizeUsage({ promptTokenCount: 8, candidatesTokenCount: 3 }), {
    prompt: 8,
    completion: 3,
    total: 11,
    cached: 0,
  });
  assert.equal(normalizeUsage({}), null);
});

test('describeFetchError includes undici cause details', () => {
  const err = new Error('fetch failed');
  err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' });
  assert.equal(
    describeFetchError(err, 'http://127.0.0.1:8080'),
    'fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8080)'
  );
});

test('describeFetchError falls back to base URL when message is missing', () => {
  assert.equal(
    describeFetchError({}, 'http://localhost:11434'),
    'Connection to http://localhost:11434 failed.'
  );
  assert.equal(describeFetchError(new Error('timeout'), 'x'), 'timeout');
});

// What the providers hand the user (#308): the network's words stay quoted,
// only Snotra's own fallback sentence travels as a key.
test('describeFetchErrorMessage quotes the network and keys its own sentence', () => {
  const err = new Error('fetch failed');
  err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' });
  assert.equal(
    describeFetchErrorMessage(err, 'http://127.0.0.1:8080'),
    'fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8080)'
  );
  assert.deepEqual(describeFetchErrorMessage({}, 'http://localhost:11434'), {
    key: 'provider.error.connectionFailed',
    params: { url: 'http://localhost:11434' },
  });
  // `formatRoundError` has no address to name.
  assert.deepEqual(describeFetchErrorMessage({}), { key: 'provider.error.connectionFailed.generic' });
  assert.deepEqual(describeFetchErrorMessage({ cause: { code: 'ENOTFOUND' } }), {
    key: 'provider.error.withCause',
    params: { message: { key: 'provider.error.connectionFailed.generic' }, cause: 'ENOTFOUND' },
  });
});

test('mergeUsage sums usage across rounds', () => {
  assert.deepEqual(
    mergeUsage(
      { prompt: 10, completion: 5, total: 15 },
      { prompt: 3, completion: 2, total: 5 }
    ),
    { prompt: 13, completion: 7, total: 20, cached: 0 }
  );
});

// --- iterSseEvents edge cases ---

const { iterSseEvents } = require('../src/main/providers/stream-helpers');
const { readerFromChunks } = require('./helpers/sse');

async function collectEvents(chunks, abortSignal) {
  const out = [];
  for await (const evt of iterSseEvents(readerFromChunks(chunks), abortSignal)) {
    out.push(evt);
  }
  return out;
}

test('iterSseEvents parses multiple events from a single chunk', async () => {
  const events = await collectEvents(['data: one\n\ndata: two\n\n']);
  assert.deepEqual(events, [
    { event: null, data: 'one' },
    { event: null, data: 'two' },
  ]);
});

test('iterSseEvents reassembles events split across chunk boundaries', async () => {
  const events = await collectEvents(['event: resp', 'onse.delta\nda', 'ta: {"a":1}\n\n']);
  assert.deepEqual(events, [{ event: 'response.delta', data: '{"a":1}' }]);
});

test('iterSseEvents handles CRLF line endings', async () => {
  const events = await collectEvents(['event: x\r\ndata: y\r\n\r\n']);
  assert.deepEqual(events, [{ event: 'x', data: 'y' }]);
});

test('iterSseEvents joins multiple data lines with newlines', async () => {
  const events = await collectEvents(['data: line1\ndata: line2\n\n']);
  assert.deepEqual(events, [{ event: null, data: 'line1\nline2' }]);
});

test('iterSseEvents skips comment lines and strips one leading space after data:', async () => {
  const events = await collectEvents([': keep-alive\ndata:  two-spaces\n\n']);
  assert.deepEqual(events, [{ event: null, data: ' two-spaces' }]);
});

test('iterSseEvents flushes a trailing event without final blank line', async () => {
  const events = await collectEvents(['data: tail']);
  assert.deepEqual(events, [{ event: null, data: 'tail' }]);
});

test('iterSseEvents emits nothing for empty or comment-only streams', async () => {
  assert.deepEqual(await collectEvents([]), []);
  assert.deepEqual(await collectEvents([': ping\n\n: pong\n\n']), []);
});

test('iterSseEvents resets the event name after each dispatch', async () => {
  const events = await collectEvents(['event: first\ndata: a\n\ndata: b\n\n']);
  assert.deepEqual(events, [
    { event: 'first', data: 'a' },
    { event: null, data: 'b' },
  ]);
});

test('iterSseEvents stops with an AbortError when the signal fires mid-stream', async () => {
  const controller = new AbortController();
  const chunks = ['data: one\n\n', 'data: two\n\n'];
  const out = [];
  await assert.rejects(
    (async () => {
      for await (const evt of iterSseEvents(readerFromChunks(chunks), controller.signal)) {
        out.push(evt);
        controller.abort();
      }
    })(),
    (err) => isAbortError(err)
  );
  assert.deepEqual(out, [{ event: null, data: 'one' }]);
});

// --- Limits on what a server sends (#539) ------------------------------------

const {
  iterStreamLines,
  readErrorMessage,
  MAX_ERROR_BODY_BYTES,
} = require('../src/main/providers/stream-helpers');
const { sseResponse, mockFetch, collectCallbacks } = require('./helpers/sse');
const { translateMessage } = require('../src/shared/i18n');

async function drain(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('a line without an end stops at the limit instead of growing forever (#539)', async () => {
  const chunk = 'x'.repeat(1000);
  let reads = 0;
  let cancelled = false;
  const endless = {
    async read() {
      reads += 1;
      return { done: false, value: new TextEncoder().encode(chunk) };
    },
    async cancel() { cancelled = true; },
  };
  await assert.rejects(
    () => drain(iterStreamLines(endless, undefined, { maxLineChars: 10_000 })),
    (err) => /longer than/.test(err.message)
      && /larger than 8 MB/.test(translateMessage('en', describeFetchErrorMessage(err)))
  );
  assert.ok(reads <= 11, `stopped right after the limit, read ${reads} chunks`);
  assert.equal(cancelled, true, 'the rest of the stream is not fetched');
});

test('lines and events below the limit pass unchanged', async () => {
  const big = 'y'.repeat(5000);
  const lines = await drain(iterStreamLines(readerFromChunks([`${big}\nshort\r\n`]), undefined, { maxLineChars: 5000 }));
  assert.deepEqual(lines, [big, 'short']);

  const events = await drain(iterSseEvents(readerFromChunks([`data: ${big}\n\n`]), undefined, { maxEventChars: 5010 }));
  assert.equal(events[0].data, big);
});

test('an event split over many data lines counts as one (#539)', async () => {
  const lines = Array.from({ length: 20 }, () => `data: ${'z'.repeat(100)}\n`).join('');
  await assert.rejects(
    () => drain(iterSseEvents(readerFromChunks([lines, '\n']), undefined, { maxEventChars: 1000 })),
    /longer than/
  );
});

test('an error body is read only as far as it is shown (#539)', async () => {
  let delivered = 0;
  let cancelled = false;
  const res = {
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    body: {
      getReader: () => ({
        async read() {
          delivered += 16 * 1024;
          return { done: false, value: new Uint8Array(16 * 1024).fill(0x61) };
        },
        async cancel() { cancelled = true; },
      }),
    },
  };
  const message = await readErrorMessage(res);
  assert.equal(message.length, 300, 'the shown excerpt is unchanged');
  assert.ok(delivered <= MAX_ERROR_BODY_BYTES + 16 * 1024, `read ${delivered} bytes`);
  assert.equal(cancelled, true);

  const json = sseResponse([JSON.stringify({ error: { message: 'quota' } })], { status: 429 });
  assert.equal(await readErrorMessage(json), 'quota');
});

test('a hostile tool-call index neither blocks nor loses the other calls (#539)', async (t) => {
  const compatible = require('../src/main/providers/openai-compatible');
  const data = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
  mockFetch(t, () => sseResponse([
    data({ choices: [{ delta: { tool_calls: [{ index: 2e9, id: 'b', function: { name: 'second', arguments: '{}' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: -1, id: 'a', function: { name: 'first', arguments: '{}' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]));
  const started = Date.now();
  const res = await compatible.streamChatRound({
    config: { baseUrl: 'http://127.0.0.1:1/v1' },
    model: 'm',
    messages: [{ role: 'user', content: 'Hi' }],
    callbacks: collectCallbacks().callbacks,
  });
  assert.ok(Date.now() - started < 1000, 'no walk over a sparse array');
  assert.deepEqual(res.message.tool_calls.map((tc) => tc.function.name), ['first', 'second']);
});
