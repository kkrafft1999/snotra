// Live transcription through the realtime API (#859), against a WebSocket that
// stands in for OpenAI: what goes out, in which order, and what the turns look
// like on the way back.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRealtimeTranscriptionService,
  REALTIME_TRANSCRIPTION_URL,
} = require('../src/main/services/realtime-transcription-service');

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.listeners = {};
    this.closed = false;
    FakeSocket.last = this;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
  emit(type, payload = {}) {
    for (const fn of this.listeners[type] || []) fn(payload);
  }
  server(event) {
    this.emit('message', { data: JSON.stringify(event) });
  }
  types() {
    return this.sent.map((event) => event.type);
  }
}

function makeService(overrides = {}) {
  FakeSocket.last = null;
  return createRealtimeTranscriptionService({
    credentials: { getApiKey: async () => 'sk-test' },
    getAppLocale: async () => 'de',
    getWebSocket: () => FakeSocket,
    ...overrides,
  });
}

/** PCM chunks of 100 ms: a tone for speech, zeros for a pause. */
function chunk(loud) {
  const samples = new Int16Array(2400);
  if (loud) for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(Math.sin(i / 5) * 8000);
  return Buffer.from(samples.buffer);
}

async function openUp(service, handlers = {}) {
  const updates = [];
  const errors = [];
  const session = service.open({
    onUpdate: (update) => updates.push(update),
    onError: (error) => errors.push(error),
    ...handlers,
  });
  assert.deepEqual(await session.started, { ok: true });
  const socket = FakeSocket.last;
  socket.emit('open');
  socket.server({ type: 'session.created' });
  socket.server({ type: 'session.updated' });
  return { session, socket, updates, errors };
}

test('opens a transcription session with the key in the header and the interface language', async () => {
  const service = makeService();
  const { socket } = await openUp(service);
  assert.equal(socket.url, REALTIME_TRANSCRIPTION_URL);
  assert.deepEqual(socket.options, { headers: { Authorization: 'Bearer sk-test' } });
  const [update] = socket.sent;
  assert.equal(update.type, 'session.update');
  assert.equal(update.session.type, 'transcription');
  assert.deepEqual(update.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(update.session.audio.input.transcription.model, 'gpt-live-transcribe');
  assert.deepEqual(update.session.audio.input.transcription.languages, ['de']);
  assert.equal(update.session.audio.input.turn_detection, null);
});

test('without a key the start fails at once and nothing is connected', async () => {
  const service = makeService({ credentials: { getApiKey: async () => '' } });
  const session = service.open({});
  assert.deepEqual(await session.started, { error: { key: 'chat.voice.error.noApiKey' } });
  assert.equal(FakeSocket.last, null);
});

test('audio spoken while connecting waits for the session and goes out in order', async () => {
  const service = makeService();
  const session = service.open({});
  await session.started;
  const socket = FakeSocket.last;
  session.append(chunk(true));
  session.append(chunk(true));
  socket.emit('open');
  assert.deepEqual(socket.types(), ['session.update']);
  socket.server({ type: 'session.updated' });
  assert.deepEqual(socket.types(), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.append']);
  assert.equal(Buffer.from(socket.sent[1].audio, 'base64').length, 4800);
});

test('words grow the turn being spoken; a pause commits it and the completion settles it', async () => {
  const service = makeService();
  const { session, socket, updates } = await openUp(service);
  for (let i = 0; i < 10; i += 1) session.append(chunk(true));
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'hallo' });
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: ' welt' });
  assert.deepEqual(updates.at(-1), { turns: [{ text: 'hallo welt', final: false }], settledBytes: 0 });

  for (let i = 0; i < 10; i += 1) session.append(chunk(false));
  const commits = socket.sent.filter((event) => event.type === 'input_audio_buffer.commit');
  assert.equal(commits.length, 1, 'one commit at the pause');

  socket.server({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
  socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Hallo Welt.' });
  const last = updates.at(-1);
  assert.deepEqual(last.turns, [{ text: 'Hallo Welt.', final: true }]);
  assert.ok(last.settledBytes > 0, 'the settled turn covers the audio up to its commit');
});

test('turns keep the spoken order even when their completions arrive the other way round', async () => {
  const service = makeService();
  const { socket, updates } = await openUp(service);
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'eins' });
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'zwei' });
  socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'Zwei.' });
  assert.deepEqual(updates.at(-1).turns, [{ text: 'eins', final: false }, { text: 'Zwei.', final: true }]);
});

test('stop commits what is still open and waits for it to settle', async () => {
  const service = makeService();
  const { session, socket } = await openUp(service);
  for (let i = 0; i < 5; i += 1) session.append(chunk(true));
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'noch offen' });
  const finishing = session.finish();
  await tick();
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.commit');
  session.append(chunk(true));
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.commit', 'no audio after the stop');
  socket.server({ type: 'input_audio_buffer.committed', item_id: 'a' });
  socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Noch offen.' });
  const result = await finishing;
  assert.deepEqual(result.turns, [{ text: 'Noch offen.', final: true }]);
  assert.equal(socket.closed, true);
});

test('a refused empty commit at the stop is harmless', async () => {
  const service = makeService();
  const { session, socket } = await openUp(service);
  session.append(chunk(true));
  const finishing = session.finish();
  await tick();
  const commit = socket.sent.at(-1);
  socket.server({ type: 'error', error: { type: 'invalid_request_error', code: 'input_audio_buffer_commit_empty', message: 'buffer too small', event_id: commit.event_id } });
  const result = await finishing;
  assert.equal(result.error, undefined);
});

test('a turn that does not settle in time comes back with the words heard of it', async () => {
  const service = makeService({ finishTimeoutMs: 20 });
  const { session, socket } = await openUp(service);
  session.append(chunk(true));
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'halb' });
  const result = await session.finish();
  assert.deepEqual(result.turns, [{ text: 'halb', final: true }]);
});

test('a connection lost while recording is reported once, and the session is over', async () => {
  const service = makeService();
  const { session, socket, errors } = await openUp(service);
  socket.emit('close', { code: 1006 });
  assert.deepEqual(errors, [{ key: 'chat.voice.error.connection' }]);
  session.append(chunk(true));
  assert.equal(socket.sent.length, 1, 'nothing more goes out');
});

test('an error from OpenAI is quoted as it stands', async () => {
  const service = makeService();
  const { socket, errors } = await openUp(service);
  socket.server({ type: 'error', error: { type: 'invalid_request_error', message: 'Model not available.' } });
  assert.deepEqual(errors, ['Model not available.']);
});

test('a connection that never comes up is reported after the timeout', async () => {
  const service = makeService({ connectTimeoutMs: 10 });
  const errors = [];
  const session = service.open({ onError: (error) => errors.push(error) });
  await session.started;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(errors, [{ key: 'chat.voice.error.connection' }]);
  assert.equal(FakeSocket.last.closed, true);
});

test('after a failure during the stop, open turns stay open and say where their audio begins', async () => {
  const service = makeService();
  const { session, socket } = await openUp(service);
  for (let i = 0; i < 10; i += 1) session.append(chunk(true));
  for (let i = 0; i < 10; i += 1) session.append(chunk(false));
  socket.server({ type: 'input_audio_buffer.committed', item_id: 'a' });
  socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Erster Satz.' });
  for (let i = 0; i < 5; i += 1) session.append(chunk(true));
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'zweiter' });
  const finishing = session.finish();
  await tick();
  socket.emit('close', { code: 1006 });
  const result = await finishing;
  assert.deepEqual(result.error, { key: 'chat.voice.error.connection' });
  assert.deepEqual(result.turns, [{ text: 'Erster Satz.', final: true }, { text: 'zweiter', final: false }]);
  // The commit went out 700 ms into the pause: 1 s of speech, 0.7 s of quiet.
  assert.equal(result.settledBytes, 17 * 4800);
});

test('cancel closes at once and reports nothing', async () => {
  const service = makeService();
  const { session, socket, updates, errors } = await openUp(service);
  session.cancel();
  socket.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'spät' });
  socket.emit('close', {});
  assert.equal(socket.closed, true);
  assert.deepEqual(updates, []);
  assert.deepEqual(errors, []);
});
