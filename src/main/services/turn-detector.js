'use strict';

/**
 * Where a spoken turn ends, judged by how loud the microphone is (#859).
 *
 * gpt-live-transcribe streams words while the audio arrives, but it settles a
 * turn — casing, punctuation, a misheard word put right — only once the client
 * commits the audio buffer, and it has no voice detection of its own. This
 * decides when to commit: after some speech, at the first pause long enough to
 * be one.
 *
 * Loudness alone is a crude measure, but Chromium's capture already suppresses
 * noise and levels the gain, and getting it wrong is cheap: a pause taken for
 * an end only settles the text a little earlier, a missed one a little later.
 * No text is lost either way.
 */

const FRAME_MS = 20;
// Below this a frame counts as quiet however low the room noise is; a
// whisper still reaches it, the hum of a laptop fan does not.
const MIN_SPEECH_LEVEL = 0.012;
// A frame is speech when it is this many times louder than the room.
const SPEECH_OVER_FLOOR = 3;
const INITIAL_FLOOR = 0.003;

/**
 * @param {object} [options]
 * @param {number} [options.sampleRate]  of the 16-bit PCM pushed in
 * @param {number} [options.pauseMs]     quiet that ends a turn
 * @param {number} [options.minSpeechMs] speech a turn needs before a pause can end it
 * @param {number} [options.longTurnMs]  after this much talking, a shorter breath ends the turn
 * @param {number} [options.maxTurnMs]   a turn ends here, pause or not
 */
function createTurnDetector({
  sampleRate = 24000,
  pauseMs = 700,
  minSpeechMs = 200,
  longTurnMs = 20000,
  maxTurnMs = 30000,
} = {}) {
  const frameSamples = Math.round((sampleRate * FRAME_MS) / 1000);
  let floor = INITIAL_FLOOR;
  let frameSquares = 0;
  let frameFill = 0;
  // The turn since the last end: how much of it was speech, how long since it
  // began to speak, and how long it has been quiet now.
  let speechMs = 0;
  let turnMs = 0;
  let quietMs = 0;

  /**
   * @param {number} level  the frame's RMS level
   */
  function frameEnds(level) {
    const speaking = level > Math.max(MIN_SPEECH_LEVEL, floor * SPEECH_OVER_FLOOR);
    if (speaking) {
      speechMs += FRAME_MS;
      quietMs = 0;
    } else {
      // The room is measured only while nobody speaks, and it follows slowly:
      // a door that shuts should not lift the bar for the next sentence.
      floor = floor * 0.95 + level * 0.05;
      quietMs += FRAME_MS;
    }
    if (speechMs > 0) turnMs += FRAME_MS;
    if (speechMs < minSpeechMs) {
      // A click or a cough is not a turn; forget it once it is over.
      if (!speaking && quietMs >= pauseMs) {
        speechMs = 0;
        turnMs = 0;
      }
      return false;
    }
    const ended = quietMs >= pauseMs
      || (turnMs >= longTurnMs && quietMs >= FRAME_MS * 5)
      || turnMs >= maxTurnMs;
    if (ended) {
      speechMs = 0;
      turnMs = 0;
      quietMs = 0;
    }
    return ended;
  }

  /**
   * Feeds samples in; true when a turn ended somewhere inside them.
   * @param {Int16Array} samples
   */
  function push(samples) {
    let ended = false;
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples[i] / 32768;
      frameSquares += value * value;
      frameFill += 1;
      if (frameFill === frameSamples) {
        if (frameEnds(Math.sqrt(frameSquares / frameSamples))) ended = true;
        frameSquares = 0;
        frameFill = 0;
      }
    }
    return ended;
  }

  /** Whether the turn now running has had speech in it. */
  function hasSpeech() {
    return speechMs > 0;
  }

  return { push, hasSpeech };
}

module.exports = { createTurnDetector };
