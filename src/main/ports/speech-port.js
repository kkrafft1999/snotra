/**
 * Speech recognition, live while the user speaks (#859).
 *
 * @typedef {{ text: string, final: boolean }} TranscriptTurn
 *
 * @typedef {Object} LiveTranscription
 * @property {Promise<{ ok: true } | { error: string|object }>} started  resolved once a key is there
 * @property {(pcm: Buffer) => void} append  16-bit mono PCM at 24 kHz
 * @property {() => Promise<{ turns: TranscriptTurn[], settledBytes: number, error?: string|object }>} finish
 * @property {() => void} cancel
 *
 * @typedef {Object} SpeechPort
 * @property {(options: {
 *   onUpdate?: (update: { turns: TranscriptTurn[], settledBytes: number }) => void,
 *   onError?: (error: string|object) => void,
 * }) => LiveTranscription} openLiveTranscription
 * @property {(audioBuffer: Buffer|ArrayBuffer, options?: { language?: string }) => Promise<{ text?: string, error?: string }>} transcribeAudio
 *   one recording in one piece (Whisper) — the fallback when live fails
 */

module.exports = {};
