'use strict';

const { isVoiceChunk } = require('../../shared/contracts/voice');

/** The bytes of an ArrayBuffer or of any view on one — not its element values (#541). */
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
 */
function registerVoiceHandlers({ ipcMain, speech, REQ, PUSH }) {
  const recordings = new Map();
  const watched = new WeakSet();

  function drop(sender) {
    const recording = recordings.get(sender);
    if (!recording) return;
    recordings.delete(sender);
    recording.session.cancel();
  }

  function push(sender, recording, payload) {
    if (recordings.get(sender) !== recording || !sender || sender.isDestroyed?.()) return;
    sender.send(PUSH.VOICE_TRANSCRIPT, { id: recording.id, ...payload });
  }

  ipcMain.handle(REQ.VOICE_START, async (event, payload) => {
    const sender = event.sender;
    const id = payload?.id;
    if (!Number.isSafeInteger(id)) return { error: 'invalid recording' };
    drop(sender);
    const recording = { id, session: null };
    recording.session = speech.openLiveTranscription({
      onUpdate: (update) => push(sender, recording, update),
      onError: (error) => {
        push(sender, recording, { error });
        if (recordings.get(sender) === recording) recordings.delete(sender);
      },
    });
    recordings.set(sender, recording);
    if (sender && !watched.has(sender)) {
      watched.add(sender);
      sender.once?.('destroyed', () => drop(sender));
    }
    // Answers once the key is there — the connection itself is still being
    // set up, and the audio spoken meanwhile waits for it.
    const started = await recording.session.started;
    if (started.error) {
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
