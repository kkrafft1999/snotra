// Live voice input in the composer (#859): the dictation appears in the input
// field while it is spoken, stays editable where it is settled, and falls back
// to Whisper when the live transcription fails. Layout — that the mirror lines
// up with the textarea — is checked in the running app (e2e/voice-input.test.mjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const CHUNK = 4800;

async function mount({ startResult = { ok: true }, micError = null } = {}) {
  const dom = setupRendererDom();
  const { initVoiceRecorder } = await importRenderer('voice', 'VoiceRecorder.js');
  const calls = [];
  const api = {
    stopResult: { turns: [], settledBytes: 0 },
    whisperResult: { text: '' },
    startVoice: async (id) => { calls.push(['start', id]); return startResult; },
    sendVoiceAudio: (id, pcm) => calls.push(['audio', id, pcm.byteLength]),
    stopVoice: async (id) => { calls.push(['stop', id]); return api.stopResult; },
    cancelVoice: async () => { calls.push(['cancel']); },
    transcribeAudio: async (wav) => { calls.push(['whisper', wav]); return api.whisperResult; },
    cancelTranscription: async () => { calls.push(['cancelWhisper']); },
    onVoiceTranscript: (cb) => { api.push = cb; },
    onToggleVoiceInput: (cb) => { api.shortcut = cb; },
  };
  const mic = { opened: 0, stopped: 0, onChunk: null };
  const voice = initVoiceRecorder({
    api,
    onInputChanged() {},
    isMac: true,
    openMic: async ({ onChunk }) => {
      if (micError) throw micError;
      mic.opened += 1;
      mic.onChunk = onChunk;
      return { stop: () => { mic.stopped += 1; } };
    },
  });
  const $ = (id) => document.getElementById(id);
  const chunks = (count) => {
    for (let i = 0; i < count; i += 1) mic.onChunk(new ArrayBuffer(CHUNK), 0.1);
  };
  // A recording left running keeps its clock and limit timers — and the test
  // process — alive.
  const cleanup = () => {
    voice.stopChatVoiceListening();
    dom.cleanup();
  };
  return { cleanup, api, calls, mic, voice, $, chunks };
}

async function record(ctx) {
  ctx.$('btn-chat-mic').click();
  await tick();
  await tick();
}

const dictation = ($) => $('chat-input-mirror').querySelector('.chat-dictation')?.textContent;

test('the dictation appears in the field while it is spoken, grey until the stop', async (t) => {
  const ctx = await mount();
  t.after(ctx.cleanup);
  const { $, api, calls } = ctx;
  await record(ctx);
  assert.deepEqual(calls[0], ['start', 1]);
  assert.equal(ctx.mic.opened, 1);
  assert.equal($('btn-chat-mic').getAttribute('aria-pressed'), 'true');
  assert.equal($('chat-input-field').dataset.dictating, 'true');
  assert.equal($('chat-input').closest('#chat-input-row').querySelector('.chat-composer-bar').dataset.dictating, 'true');
  assert.equal($('chat-voice-status').textContent, 'Recording …');
  assert.equal($('chat-voice-level').classList.contains('hidden'), false);

  ctx.chunks(3);
  assert.deepEqual(calls.filter(([kind]) => kind === 'audio').length, 3);

  api.push({ id: 1, turns: [{ text: 'kannst du', final: false }], settledBytes: 0 });
  assert.equal($('chat-input').value, 'kannst du');
  api.push({ id: 1, turns: [{ text: 'Kannst du helfen?', final: true }, { text: 'und dann', final: false }], settledBytes: CHUNK });
  assert.equal($('chat-input').value, 'Kannst du helfen? und dann');
  assert.equal(dictation($), 'Kannst du helfen? und dann');

  api.stopResult = { turns: [{ text: 'Kannst du helfen?', final: true }, { text: 'Und dann senden.', final: true }], settledBytes: CHUNK * 3 };
  $('btn-chat-mic').click();
  assert.equal(ctx.mic.stopped, 1, 'the microphone goes out at the stop');
  await tick();
  assert.equal($('chat-input').value, 'Kannst du helfen? Und dann senden.');
  assert.equal($('chat-input-field').dataset.dictating, undefined);
  assert.equal(dictation($), undefined);
  assert.equal($('chat-voice-status').classList.contains('hidden'), true);
  assert.equal($('btn-chat-mic').getAttribute('aria-pressed'), 'false');
  assert.equal(document.activeElement, $('chat-input'));
});

test('typed text stays; the dictation goes in at the caret, spaced from its neighbours', async (t) => {
  const ctx = await mount();
  t.after(ctx.cleanup);
  const { $, api } = ctx;
  const input = $('chat-input');
  input.value = 'Zu #859:Danke';
  input.setSelectionRange(8, 8);
  await record(ctx);
  api.push({ id: 1, turns: [{ text: 'Zeig mir die Mockups.', final: true }], settledBytes: 0 });
  assert.equal(input.value, 'Zu #859: Zeig mir die Mockups. Danke');
  // The space in front belongs to the dictation; it shows as nothing either way.
  assert.equal(dictation($), ' Zeig mir die Mockups.');
});

test('a settled word can be corrected while recording; the turn being spoken cannot be edited', async (t) => {
  const ctx = await mount();
  t.after(ctx.cleanup);
  const { $, api } = ctx;
  const input = $('chat-input');
  await record(ctx);
  api.push({ id: 1, turns: [{ text: 'Frag Notra.', final: true }, { text: 'und', final: false }], settledBytes: 0 });
  assert.equal(input.value, 'Frag Notra. und');

  // Typing inside "und" is refused.
  input.setSelectionRange(13, 13);
  const refused = new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', cancelable: true });
  input.dispatchEvent(refused);
  assert.equal(refused.defaultPrevented, true);

  // "Notra" → "Snotra": an insertion in the settled part.
  input.setSelectionRange(5, 5);
  const allowed = new InputEvent('beforeinput', { inputType: 'insertText', data: 'S', cancelable: true });
  input.dispatchEvent(allowed);
  assert.equal(allowed.defaultPrevented, false);
  input.value = 'Frag SNotra. und';
  input.setSelectionRange(6, 6);
  input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'S' }));

  api.push({ id: 1, turns: [{ text: 'Frag Notra.', final: true }, { text: 'und dann', final: false }], settledBytes: 0 });
  assert.equal(input.value, 'Frag SNotra. und dann', 'the correction survives the next word');
  assert.equal(input.selectionStart, 6, 'the caret stays where the user put it');
  assert.equal(dictation($), 'Frag SNotra. und dann');
});

test('without an OpenAI key the microphone is never opened', async (t) => {
  const ctx = await mount({ startResult: { error: { key: 'chat.voice.error.noApiKey' } } });
  t.after(ctx.cleanup);
  await record(ctx);
  assert.equal(ctx.mic.opened, 0);
  assert.equal(ctx.$('chat-voice-status').textContent, 'Error: No OpenAI key stored (voice input needs one).');
  assert.equal(ctx.$('btn-chat-mic').getAttribute('aria-pressed'), 'false');
  assert.equal(ctx.$('chat-input-field').dataset.dictating, undefined);
});

test('a refused microphone says so and drops the session', async (t) => {
  const ctx = await mount({ micError: Object.assign(new Error('denied'), { name: 'NotAllowedError' }) });
  t.after(ctx.cleanup);
  await record(ctx);
  assert.equal(ctx.$('chat-voice-status').textContent, 'Microphone access denied.');
  assert.deepEqual(ctx.calls.at(-1), ['cancel']);
});

test('live text failing mid-recording: recording goes on, Whisper hears what was not settled', async (t) => {
  const ctx = await mount();
  t.after(ctx.cleanup);
  const { $, api, calls } = ctx;
  await record(ctx);
  ctx.chunks(10);
  api.push({ id: 1, turns: [{ text: 'Erster Satz.', final: true }, { text: 'zweit', final: false }], settledBytes: 6 * CHUNK });
  api.push({ id: 1, error: { key: 'chat.voice.error.connection' } });
  assert.equal($('chat-input').value, 'Erster Satz.', 'the open turn goes; Whisper hears it again');
  assert.equal($('chat-voice-status').textContent, 'Recording without live text — the text follows when you stop.');
  assert.equal($('btn-chat-mic').getAttribute('aria-pressed'), 'true');

  ctx.chunks(5);
  assert.equal(calls.filter(([kind]) => kind === 'audio').length, 10, 'no more audio to the live session');

  api.whisperResult = { text: 'Zweiter Satz.' };
  $('btn-chat-mic').click();
  await tick();
  await tick();
  assert.equal(calls.some(([kind]) => kind === 'stop'), false, 'the failed session is not asked again');
  const [, wav] = calls.find(([kind]) => kind === 'whisper');
  assert.equal(new TextDecoder().decode(new Uint8Array(wav, 0, 4)), 'RIFF');
  assert.equal(wav.byteLength, 44 + 9 * CHUNK, 'from the end of the settled turn to the stop');
  assert.equal($('chat-input').value, 'Erster Satz. Zweiter Satz.');
  assert.equal(
    $('chat-voice-status').textContent,
    'No live text (Could not reach OpenAI’s speech recognition. Check the OpenAI key and the network.). Transcribed with Whisper instead.',
  );
});

test('live text failing during the stop falls back the same way', async (t) => {
  const ctx = await mount();
  t.after(ctx.cleanup);
  const { $, api, calls } = ctx;
  await record(ctx);
  ctx.chunks(8);
  api.stopResult = {
    turns: [{ text: 'Eins.', final: true }, { text: 'zw', final: false }],
    settledBytes: 4 * CHUNK,
    error: 'Model not available.',
  };
  api.whisperResult = { text: 'Zwei.' };
  $('btn-chat-mic').click();
  await tick();
  await tick();
  const [, wav] = calls.find(([kind]) => kind === 'whisper');
  assert.equal(wav.byteLength, 44 + 4 * CHUNK);
  assert.equal($('chat-input').value, 'Eins. Zwei.');
  assert.match($('chat-voice-status').textContent, /^No live text \(Model not available\.\)/);
});

test('when Whisper fails too, the text so far stays and the error is shown', async (t) => {
  const ctx = await mount();
  t.after(ctx.cleanup);
  const { $, api } = ctx;
  await record(ctx);
  ctx.chunks(8);
  api.push({ id: 1, turns: [{ text: 'Eins.', final: true }], settledBytes: 2 * CHUNK });
  api.push({ id: 1, error: { key: 'chat.voice.error.connection' } });
  api.whisperResult = { error: 'Network down.' };
  $('btn-chat-mic').click();
  await tick();
  await tick();
  assert.equal($('chat-input').value, 'Eins.');
  assert.equal($('chat-voice-status').textContent, 'Error: Network down.');
});

test('Cmd/Ctrl+D starts and stops; a held key does not flicker', async (t) => {
  const ctx = await mount();
  t.after(ctx.cleanup);
  const { $, api } = ctx;
  assert.equal($('btn-chat-mic').getAttribute('aria-keyshortcuts'), 'Meta+D');
  assert.equal($('btn-chat-mic').title, 'Voice input (⌘D)');
  api.shortcut();
  await tick();
  await tick();
  assert.equal($('btn-chat-mic').getAttribute('aria-pressed'), 'true');
  api.shortcut();
  assert.equal($('btn-chat-mic').getAttribute('aria-pressed'), 'true', 'a repeat right after is ignored');
});

test('sending mid-recording ends it; what was dictated is plain text in the field', async (t) => {
  const ctx = await mount();
  t.after(ctx.cleanup);
  const { $, api, calls, voice } = ctx;
  await record(ctx);
  api.push({ id: 1, turns: [{ text: 'Fertig.', final: true }, { text: 'und noch', final: false }], settledBytes: 0 });
  voice.stopChatVoiceListening();
  assert.deepEqual(calls.at(-1), ['cancel']);
  assert.equal($('chat-input').value, 'Fertig. und noch');
  assert.equal($('chat-input-field').dataset.dictating, undefined);
  api.push({ id: 1, turns: [{ text: 'zu spät', final: true }], settledBytes: 0 });
  assert.equal($('chat-input').value, 'Fertig. und noch');
});
