'use strict';

/**
 * What the adapter needs of the two services, written from its side.
 * @typedef {import('../ports/speech-port').SpeechPort} SpeechPort
 * @typedef {{ open: SpeechPort['openLiveTranscription'] }} RealtimeTranscription
 * @typedef {{ transcribeAudio: SpeechPort['transcribeAudio'] }} Whisper
 *
 * @param {RealtimeTranscription} realtimeTranscription
 * @param {Whisper} whisperService
 * @returns {import('../ports/speech-port').SpeechPort}
 */
function createSpeechAdapter(realtimeTranscription, whisperService) {
  return {
    openLiveTranscription(options) {
      return realtimeTranscription.open(options);
    },
    transcribeAudio(audioBuffer, options) {
      return whisperService.transcribeAudio(audioBuffer, options);
    },
  };
}

module.exports = {
  createSpeechAdapter,
};
