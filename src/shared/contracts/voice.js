'use strict';

const { createMessage } = require('./message');

/**
 * Limits and wire format for voice input.
 *
 * Since #859 the microphone streams while the user speaks: the renderer
 * captures 16-bit mono PCM at 24 kHz and hands it to main in small chunks,
 * and main passes it on to OpenAI's realtime transcription. When that cannot
 * be reached, or drops out, the renderer keeps the audio and sends it to
 * Whisper in one piece at the stop — as WAV, about 2.9 MB a minute, so the
 * time limit keeps it well under Whisper's 25 MB. The time limit also stops a
 * forgotten microphone: every minute is billed.
 */

const MAX_VOICE_RECORDING_MS = 5 * 60 * 1000;
// How long before the automatic stop the user is told it is coming.
const VOICE_STOP_WARNING_MS = 30 * 1000;
// The format the realtime session is opened with; the renderer records in it.
const VOICE_SAMPLE_RATE = 24000;
// The renderer sends 100 ms per chunk (4,800 bytes). The ceiling leaves room
// for a larger flush without letting one message carry a whole recording.
const MAX_VOICE_CHUNK_BYTES = 64 * 1024;

// Whisper rejects anything above 25 MB; there is no point in sending it.
const MAX_TRANSCRIPTION_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The byte count of an audio payload for Whisper as it arrives over IPC, or an
 * error. Accepts an ArrayBuffer or any typed-array view; everything else is
 * refused.
 *
 * @param {*} payload  anything; only a buffer or a view on one passes
 * @returns {{ bytes: number } | { error: object }}
 */
function checkTranscriptionPayload(payload) {
  const isBuffer = payload instanceof ArrayBuffer
    || Object.prototype.toString.call(payload) === '[object ArrayBuffer]';
  if (!isBuffer && !ArrayBuffer.isView(payload)) {
    return { error: createMessage('chat.voice.error.invalidAudio') };
  }
  const bytes = payload.byteLength;
  if (bytes === 0) return { error: createMessage('chat.voice.error.invalidAudio') };
  if (bytes > MAX_TRANSCRIPTION_UPLOAD_BYTES) {
    return {
      error: createMessage('chat.voice.error.tooLarge', {
        max: MAX_TRANSCRIPTION_UPLOAD_BYTES / (1024 * 1024),
      }),
    };
  }
  return { bytes };
}

/**
 * Whether an audio chunk as it arrives over IPC is one main can pass on:
 * an ArrayBuffer or a view on one, not empty, whole 16-bit samples, under the
 * ceiling. Main cannot trust what crosses IPC.
 *
 * @param {*} payload  anything; only a buffer or a view on one passes
 * @returns {boolean}
 */
function isVoiceChunk(payload) {
  const isBuffer = payload instanceof ArrayBuffer
    || Object.prototype.toString.call(payload) === '[object ArrayBuffer]';
  if (!isBuffer && !ArrayBuffer.isView(payload)) return false;
  const bytes = payload.byteLength;
  return bytes > 0 && bytes % 2 === 0 && bytes <= MAX_VOICE_CHUNK_BYTES;
}

module.exports = {
  MAX_VOICE_RECORDING_MS,
  VOICE_STOP_WARNING_MS,
  VOICE_SAMPLE_RATE,
  MAX_VOICE_CHUNK_BYTES,
  isVoiceChunk,
  MAX_TRANSCRIPTION_UPLOAD_BYTES,
  checkTranscriptionPayload,
};
