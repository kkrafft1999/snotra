const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAbortError,
  sleepAbortable,
  normalizeUsage,
  mergeUsage,
  describeFetchError,
} = require('../src/main/providers/stream-helpers');

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
  });
  assert.deepEqual(normalizeUsage({ promptTokenCount: 8, candidatesTokenCount: 3 }), {
    prompt: 8,
    completion: 3,
    total: 11,
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
    'Verbindung zu http://localhost:11434 fehlgeschlagen.'
  );
  assert.equal(describeFetchError(new Error('timeout'), 'x'), 'timeout');
});

test('mergeUsage sums usage across rounds', () => {
  assert.deepEqual(
    mergeUsage(
      { prompt: 10, completion: 5, total: 15 },
      { prompt: 3, completion: 2, total: 5 }
    ),
    { prompt: 13, completion: 7, total: 20 }
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
