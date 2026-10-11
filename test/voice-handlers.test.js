// The IPC side of live voice input (#859): one recording per window, numbered
// by the renderer, so nothing of an abandoned recording reaches the next one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerVoiceHandlers } = require('../src/main/ipc/voice-handlers');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');

function setup({ started = { ok: true } } = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn),
  };
  const sessions = [];
  const speech = {
    openLiveTranscription(callbacks) {
      const session = {
        callbacks,
        appended: [],
        cancelled: false,
        started: Promise.resolve(started),
        append: (bytes) => session.appended.push(bytes),
        finish: async () => ({ turns: [{ text: 'Fertig.', final: true }], settledBytes: 4800 }),
        cancel: () => { session.cancelled = true; },
      };
      sessions.push(session);
      return session;
    },
  };
  registerVoiceHandlers({ ipcMain, speech, REQ, PUSH });
  const sender = Object.assign(new EventEmitter(), {
    pushed: [],
    isDestroyed: () => false,
    send(channel, payload) { this.pushed.push({ channel, payload }); },
  });
  const call = (channel, payload) => handlers.get(channel)({ sender }, payload);
  return { call, sessions, sender };
}

const pcm = (bytes = 4800) => new Uint8Array(bytes).buffer;

test('a recording starts, takes its audio and pushes its transcript under its number', async () => {
  const { call, sessions, sender } = setup();
  assert.deepEqual(await call(REQ.VOICE_START, { id: 7 }), { ok: true });
  call(REQ.VOICE_AUDIO, { id: 7, audio: pcm() });
  assert.equal(sessions[0].appended.length, 1);
  assert.equal(Buffer.isBuffer(sessions[0].appended[0]), true);

  sessions[0].callbacks.onUpdate({ turns: [{ text: 'hallo', final: false }], settledBytes: 0 });
  assert.deepEqual(sender.pushed, [{
    channel: PUSH.VOICE_TRANSCRIPT,
    payload: { id: 7, turns: [{ text: 'hallo', final: false }], settledBytes: 0 },
  }]);
  assert.deepEqual(await call(REQ.VOICE_STOP, { id: 7 }), {
    turns: [{ text: 'Fertig.', final: true }],
    settledBytes: 4800,
  });
});

test('audio of another recording, and audio that is no audio, is dropped', async () => {
  const { call, sessions } = setup();
  await call(REQ.VOICE_START, { id: 1 });
  call(REQ.VOICE_AUDIO, { id: 2, audio: pcm() });
  call(REQ.VOICE_AUDIO, { id: 1, audio: 'not audio' });
  call(REQ.VOICE_AUDIO, { id: 1, audio: pcm(3) });
  call(REQ.VOICE_AUDIO, { id: 1, audio: pcm(1024 * 1024) });
  assert.equal(sessions[0].appended.length, 0);
});

test('a new start replaces the old recording, whose late transcript goes nowhere', async () => {
  const { call, sessions, sender } = setup();
  await call(REQ.VOICE_START, { id: 1 });
  await call(REQ.VOICE_START, { id: 2 });
  assert.equal(sessions[0].cancelled, true);
  sessions[0].callbacks.onUpdate({ turns: [{ text: 'alt', final: true }], settledBytes: 0 });
  assert.deepEqual(sender.pushed, []);
  assert.deepEqual(await call(REQ.VOICE_STOP, { id: 1 }), { turns: [], settledBytes: 0 });
});

test('a failed start answers with its error and keeps nothing open', async () => {
  const { call, sessions } = setup({ started: { error: { key: 'chat.voice.error.noApiKey' } } });
  assert.deepEqual(await call(REQ.VOICE_START, { id: 1 }), { error: { key: 'chat.voice.error.noApiKey' } });
  call(REQ.VOICE_AUDIO, { id: 1, audio: pcm() });
  assert.equal(sessions[0].appended.length, 0);
});

test('an error after the start is pushed once; cancel and a closed window drop the recording', async () => {
  const { call, sessions, sender } = setup();
  await call(REQ.VOICE_START, { id: 1 });
  sessions[0].callbacks.onError({ key: 'chat.voice.error.connection' });
  assert.deepEqual(sender.pushed.at(-1).payload, { id: 1, error: { key: 'chat.voice.error.connection' } });

  await call(REQ.VOICE_START, { id: 2 });
  await call(REQ.VOICE_CANCEL);
  assert.equal(sessions[1].cancelled, true);

  await call(REQ.VOICE_START, { id: 3 });
  sender.emit('destroyed');
  assert.equal(sessions[2].cancelled, true);
  assert.equal(sender.listenerCount('destroyed'), 0, 'the window is watched once');
});

test('a start without a number is refused', async () => {
  const { call, sessions } = setup();
  assert.ok((await call(REQ.VOICE_START, {})).error);
  assert.equal(sessions.length, 0);
});
