const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/voice/WhisperRecorder.js'), 'utf8').replace('export function', 'function');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(transcribeAudio) {
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
  class Recorder {
    static isTypeSupported() { return true; }
    start() {}
    stop() {
      this.ondataavailable?.({ data: new Blob(['x'.repeat(1200)]) });
      this.onstop?.();
    }
  }
  let cancellations = 0;
  const context = vm.createContext({ document, Blob, MediaRecorder: Recorder,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  });
  vm.runInContext(source, context);
  const recorder = context.initWhisperRecorder({
    api: { transcribeAudio, cancelTranscription: async () => { cancellations += 1; } },
    onInputChanged() {},
  });
  return { elements, recorder, cancellations: () => cancellations };
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
