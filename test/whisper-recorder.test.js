const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createTranslator } = require('../src/shared/i18n');
const contracts = require('../src/shared/contracts');
// The module imports `../i18n.js` and the contracts bundle; the vm gets the
// same catalogue in German and the contracts straight from their source.
// `\r?`: a Windows checkout has CRLF, and `.` does not match the `\r`.
const source = fs.readFileSync(require.resolve('../src/renderer/voice/WhisperRecorder.js'), 'utf8')
  .replace(/^import .*\r?\n/gm, '')
  .replace('export function', 'function');
const t = createTranslator('de');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(transcribeAudio, { limits } = {}) {
  const elements = new Map();
  const document = {
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: '', textContent: '', disabled: false,
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {}, focus() {},
        addEventListener(event, fn) { this[event] = fn; },
      });
      return elements.get(id);
    },
  };
  const recorders = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { recorders.push(this); }
    start() {}
    stop() {
      this.ondataavailable?.({ data: new Blob(['x'.repeat(1200)]) });
      this.onstop?.();
    }
  }
  let cancellations = 0;
  const context = vm.createContext({ document, Blob, MediaRecorder: Recorder, contracts,
    setTimeout, clearTimeout,
    t, tMessage: t.message, onLocaleChange() {},
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  });
  vm.runInContext(source, context);
  const recorder = context.initWhisperRecorder({
    api: { transcribeAudio, cancelTranscription: async () => { cancellations += 1; } },
    onInputChanged() {},
    ...(limits ? { limits } : {}),
  });
  return { elements, recorder, recorders, cancellations: () => cancellations };
}

async function record(state) {
  const mic = state.elements.get('btn-chat-mic');
  mic.click();
  await tick();
  mic.click();
  await tick();
}

test('transcription timeout exits loading and displays the error', async () => {
  const state = setup(async () => ({ error: 'Zeitüberschreitung nach 120 s.' }));
  await record(state);
  assert.match(state.elements.get('chat-voice-status').textContent, /Zeitüberschreitung/);
  assert.equal(state.elements.get('btn-chat-mic').title, 'Spracheingabe');
  assert.equal(state.elements.get('btn-chat-mic').disabled, false);
});

// #310: the service answers with a key; the status line puts it into words.
test('a transcription error given as a key is shown in the interface language', async () => {
  const state = setup(async () => ({ error: { key: 'chat.voice.error.noApiKey' } }));
  await record(state);
  assert.equal(
    state.elements.get('chat-voice-status').textContent,
    'Fehler: Kein OpenAI-Key hinterlegt (Whisper braucht einen).'
  );
});

for (const action of ['mic', 'lifecycle']) {
  test(`${action} cancellation discards a late transcription`, async () => {
    let finish;
    const state = setup(() => new Promise((resolve) => { finish = resolve; }));
    await record(state);
    assert.equal(state.elements.get('btn-chat-mic').title, 'Transkription abbrechen');
    if (action === 'mic') state.elements.get('btn-chat-mic').click();
    else state.recorder.stopChatVoiceListening();
    assert.equal(state.cancellations(), 1);
    finish({ text: 'must not appear' });
    await tick();
    assert.equal(state.elements.get('chat-input').value, '');
    assert.equal(state.elements.get('chat-voice-status').textContent, '');
  });
}

// ── Recording limits (#76) ──────────────────────────────────────────────────

// The vm picks up whatever `setTimeout` is global at setup time, so mock the
// timers first and the real five minutes pass in an instant.

test('the default limits are the ones from the contracts', () => {
  assert.equal(contracts.MAX_VOICE_RECORDING_MS, 5 * 60 * 1000);
  assert.equal(contracts.MAX_VOICE_RECORDING_BYTES, 20 * 1024 * 1024);
  assert.equal(contracts.VOICE_STOP_WARNING_MS, 30 * 1000);
  assert.ok(contracts.MAX_VOICE_RECORDING_BYTES < contracts.MAX_TRANSCRIPTION_UPLOAD_BYTES,
    'the renderer stops before main would refuse');
});

test('a recording warns before the time limit, stops at it and says so once the text is in', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const state = setup(async (buf) => { sent.push(buf); return { text: 'Hallo' }; });
  const status = state.elements.get('chat-voice-status');
  state.elements.get('btn-chat-mic').click();
  await tick();
  assert.equal(status.textContent, 'Aufnahme läuft …');

  t.mock.timers.tick(4.5 * 60 * 1000 - 1);
  assert.equal(status.textContent, 'Aufnahme läuft …');
  t.mock.timers.tick(1);
  assert.equal(status.textContent, 'Aufnahme läuft … stoppt in weniger als 30 Sekunden automatisch.');

  t.mock.timers.tick(30 * 1000);
  await tick();
  assert.equal(sent.length, 1, 'stopped and sent without a click');
  assert.equal(state.elements.get('chat-input').value, 'Hallo');
  assert.equal(status.textContent, 'Aufnahme nach 5 Minuten automatisch beendet.');
});

const MIB = 1024 * 1024;

test('a recording stops once the collected bytes reach the limit', async (t) => {
  const sent = [];
  const state = setup(async (buf) => { sent.push(buf); return { text: 'Hallo' }; }, {
    limits: { maxMs: 60 * 60 * 1000, maxBytes: 2 * MIB, warnMs: 1000 },
  });
  state.elements.get('btn-chat-mic').click();
  await tick();
  const [mediaRecorder] = state.recorders;
  t.after(() => state.recorder.stopChatVoiceListening());

  mediaRecorder.ondataavailable({ data: new Blob(['x'.repeat(MIB)]) });
  assert.equal(sent.length, 0);
  mediaRecorder.ondataavailable({ data: new Blob(['x'.repeat(MIB)]) });
  await tick();

  assert.equal(sent.length, 1);
  assert.equal(state.elements.get('chat-voice-status').textContent, 'Aufnahme bei 2 MB automatisch beendet.');
});

test('stopping by hand clears the limit timers and leaves no notice behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const state = setup(async (buf) => { sent.push(buf); return { text: 'Hallo' }; });
  await record(state);
  assert.equal(sent.length, 1);
  assert.equal(state.elements.get('chat-voice-status').textContent, '');

  t.mock.timers.tick(10 * 60 * 1000);
  await tick();
  assert.equal(sent.length, 1, 'no second stop fires later');
  assert.equal(state.elements.get('chat-voice-status').textContent, '');
});
