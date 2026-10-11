'use strict';

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
