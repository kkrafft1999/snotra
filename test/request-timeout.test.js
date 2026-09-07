const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { withRequestTimeout } = require('../src/main/services/request-timeout');
const { createRequestLifecycle } = require('../src/main/ipc/request-lifecycle');
const { createWhisperService } = require('../src/main/services/whisper-service');
const never = () => new Promise(() => {});

for (const name of ['openai', 'anthropic', 'google', 'ollama', 'mlx-lm']) {
  for (const phase of ['headers', 'body', 'error-body']) {
    test(`${name}: timeout during ${phase} aborts transport and returns readable error`, async (t) => {
      let signal;
      t.mock.method(globalThis, 'fetch', async (_url, options) => {
        signal = options.signal;
        if (phase === 'headers') return never();
        return { ok: phase === 'body', json: never, text: never };
      });
      const result = await require(`../src/main/providers/${name}`).listModels({ apiKey: 'test', timeoutMs: 10 });
      assert.match(result.error, /Zeitüberschreitung/);
      assert.equal(signal.aborted, true);
    });
  }
  test(`${name}: explicit cancellation stops model listing`, async (t) => {
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(options.signal.aborted, false);
      controller.abort();
      return never();
    });
    const result = await require(`../src/main/providers/${name}`).listModels({ apiKey: 'test', signal: controller.signal });
    assert.match(result.error, /abgebrochen/);
  });
}

test('pre-aborted requests do not start work; successful requests clean up', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withRequestTimeout(() => assert.fail('must not start'), { signal: controller.signal, timeoutMs: 10 }), /abgebrochen/);
  let signal;
  assert.equal(await withRequestTimeout((s) => { signal = s; return 42; }, { timeoutMs: 5 }), 42);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(signal.aborted, false);
});

for (const cancel of [false, true]) {
  test(`Whisper ${cancel ? 'cancellation' : 'body timeout'} returns error and aborts fetch`, async () => {
    const controller = new AbortController();
    let signal;
    const service = createWhisperService({
      credentials: { getApiKey: async () => 'test' },
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        if (cancel) controller.abort();
        return { ok: true, json: never };
      },
    });
    const result = await service.transcribeAudio(Buffer.from('audio'), { timeoutMs: 10, signal: controller.signal });
    assert.match(result.error, cancel ? /abgebrochen/ : /Zeitüberschreitung/);
    assert.equal(signal.aborted, true);
  });
}

test('request lifecycle isolates senders and cancels replaced/destroyed requests', async () => {
  const lifecycle = createRequestLifecycle();
  const a = new EventEmitter();
  const b = new EventEmitter();
  const signals = [];
  const start = (sender) => lifecycle.run(sender, (signal) => {
    signals.push(signal);
    return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  });
  const first = start(a);
  const other = start(b);
  const next = start(a);
  await first;
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  lifecycle.cancel(a);
  await next;
  assert.equal(signals[2].aborted, true);
  b.emit('destroyed');
  await other;
  assert.equal(a.listenerCount('destroyed'), 0);
  assert.equal(b.listenerCount('destroyed'), 0);
});

test('Whisper IPC forwards cancellation even while preferences are loading', async () => {
  const { registerWhisperHandlers } = require('../src/main/ipc/whisper-handlers');
  const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
  const { createMockIpcMain } = require('./helpers/mock-ipc');
  const ipcMain = createMockIpcMain();
  let finishPreferences;
  registerWhisperHandlers({ ipcMain, REQ,
    uiPrefsStore: { readUIPrefs: () => new Promise((resolve) => { finishPreferences = resolve; }) },
    speech: { transcribeAudio: async (_buffer, { signal, language }) => {
      assert.equal(signal.aborted, true);
      assert.equal(language, 'de');
      return { error: 'Anfrage abgebrochen.' };
    } },
  });
  const pending = ipcMain.invoke(REQ.WHISPER_TRANSCRIBE, Buffer.from('audio'));
  await ipcMain.invoke(REQ.WHISPER_CANCEL);
  finishPreferences({ appLocale: 'de' });
  assert.deepEqual(await pending, { error: 'Anfrage abgebrochen.' });
});
