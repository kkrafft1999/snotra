'use strict';

const { createMessage } = require('./message');

/**
 * Limits for voice input (issue #76, review SNO-09).
 *
 * The recorder buffers the whole recording before it goes out in one piece,
 * so without a ceiling a forgotten microphone keeps filling memory — and every
 * copy on the way (Blob → ArrayBuffer → IPC → Buffer → multipart body)
 * doubles it once more. The renderer stops at the recording limits; main
 * checks the payload on its own, since it cannot trust what crosses IPC.
 */

// Opus in WebM runs at roughly 0.25–1 MB per minute, so in practice the time
// limit is the one that ends a recording; the byte limit catches the rest.
const MAX_VOICE_RECORDING_MS = 5 * 60 * 1000;
const MAX_VOICE_RECORDING_BYTES = 20 * 1024 * 1024;
// How long before the automatic stop the user is told it is coming.
const VOICE_STOP_WARNING_MS = 30 * 1000;
// Whisper rejects anything above 25 MB; there is no point in sending it.
const MAX_TRANSCRIPTION_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The byte count of an audio payload as it arrives over IPC, or an error.
 * Accepts an ArrayBuffer or any typed-array view; everything else is refused.
 *
 * @param {unknown} payload
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

module.exports = {
  MAX_VOICE_RECORDING_MS,
  MAX_VOICE_RECORDING_BYTES,
  VOICE_STOP_WARNING_MS,
  MAX_TRANSCRIPTION_UPLOAD_BYTES,
  checkTranscriptionPayload,
};
