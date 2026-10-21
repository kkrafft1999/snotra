'use strict';

const { isVoiceChunk } = require('../../shared/contracts/voice');

/**
 * The bytes of an ArrayBuffer or of any view on one — not its element values (#541).
 *
 * @param {ArrayBuffer|ArrayBufferView} payload
 */
function bytesOf(payload) {
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return Buffer.from(payload);
}

/**
 * Live voice input (#859). Each window has at most one recording; a new start
 * replaces the old one. The renderer numbers its recordings, and everything —
 * audio, stop, the transcript pushed back — carries that number, so nothing of
 * an abandoned recording lands in the next one.
 *
 * When the live transcription fails, main only reports it; the fallback to
 * Whisper is the renderer's — it holds the audio (whisper-handlers.js).
 *
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {import('../ports/speech-port').SpeechPort} deps.speech
 * @param {Record<string, string>} deps.REQ
 * @param {Record<string, string>} deps.PUSH
 */
function registerVoiceHandlers({ ipcMain, speech, REQ, PUSH }) {
  /** @typedef {{ id: number, session: import('../ports/speech-port').LiveTranscription }} Recording */
  /** @type {Map<import('electron').WebContents, Recording>} */
  const recordings = new Map();
  /** @type {WeakSet<import('electron').WebContents>} */
  const watched = new WeakSet();

  /** @param {import('electron').WebContents} sender */
  function drop(sender) {
    const recording = recordings.get(sender);
    if (!recording) return;
    recordings.delete(sender);
    recording.session.cancel();
  }

  /**
   * @param {import('electron').WebContents} sender
   * @param {Recording} recording
   * @param {object} payload
   */
  function push(sender, recording, payload) {
    if (recordings.get(sender) !== recording || !sender || sender.isDestroyed?.()) return;
    sender.send(PUSH.VOICE_TRANSCRIPT, { id: recording.id, ...payload });
  }

  ipcMain.handle(REQ.VOICE_START, async (event, payload) => {
    const sender = event.sender;
    const id = payload?.id;
    if (!Number.isSafeInteger(id)) return { error: 'invalid recording' };
    drop(sender);
    /** @type {Recording|null} */
    let recording = null;
    const session = speech.openLiveTranscription({
      onUpdate: (update) => {
        if (recording) push(sender, recording, update);
      },
      onError: (error) => {
        if (!recording) return;
        push(sender, recording, { error });
        if (recordings.get(sender) === recording) recordings.delete(sender);
      },
    });
    recording = { id, session };
    recordings.set(sender, recording);
    if (sender && !watched.has(sender)) {
      watched.add(sender);
      sender.once?.('destroyed', () => drop(sender));
    }
    // Answers once the key is there — the connection itself is still being
    // set up, and the audio spoken meanwhile waits for it.
    const started = await session.started;
    if ('error' in started && started.error) {
      if (recordings.get(sender) === recording) recordings.delete(sender);
      return { error: started.error };
    }
    return { ok: true };
  });

  ipcMain.on(REQ.VOICE_AUDIO, (event, payload) => {
    const recording = recordings.get(event.sender);
    if (!recording || payload?.id !== recording.id || !isVoiceChunk(payload.audio)) return;
    recording.session.append(bytesOf(payload.audio));
  });

  ipcMain.handle(REQ.VOICE_STOP, async (event, payload) => {
    const sender = event.sender;
    const recording = recordings.get(sender);
    if (!recording || payload?.id !== recording.id) return { turns: [], settledBytes: 0 };
    const result = await recording.session.finish();
    if (recordings.get(sender) === recording) recordings.delete(sender);
    return result;
  });

  ipcMain.handle(REQ.VOICE_CANCEL, (event) => {
    drop(event.sender);
  });
}

module.exports = { registerVoiceHandlers };
