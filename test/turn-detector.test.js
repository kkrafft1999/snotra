// Where a spoken turn ends (#859): the realtime model settles a turn only on a
// commit, and the commit is placed at the first real pause after speech.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTurnDetector } = require('../src/main/services/turn-detector');

const RATE = 24000;

/** `ms` of a tone at `amplitude` (0..1), as 16-bit samples. */
function tone(ms, amplitude) {
  const samples = new Int16Array(Math.round((RATE * ms) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amplitude * 32767);
  }
  return samples;
}

const silence = (ms) => tone(ms, 0);

/** Feeds the pieces in 100 ms chunks, as the renderer sends them; counts the ends. */
function feed(detector, ...pieces) {
  let ends = 0;
  for (const piece of pieces) {
    for (let at = 0; at < piece.length; at += 2400) {
      if (detector.push(piece.subarray(at, at + 2400))) ends += 1;
    }
  }
  return ends;
}

test('a pause after speech ends the turn, once', () => {
  const detector = createTurnDetector();
  assert.equal(feed(detector, silence(500), tone(1500, 0.2)), 0);
  assert.equal(detector.hasSpeech(), true);
  assert.equal(feed(detector, silence(1500)), 1);
  assert.equal(detector.hasSpeech(), false);
});

test('a breath shorter than the pause keeps the turn going', () => {
  const detector = createTurnDetector();
  assert.equal(feed(detector, tone(800, 0.2), silence(300), tone(800, 0.2)), 0);
  assert.equal(feed(detector, silence(800)), 1);
});

test('a click is no turn, and is forgotten once it is over', () => {
  const detector = createTurnDetector();
  assert.equal(feed(detector, silence(300), tone(60, 0.5), silence(1500)), 0);
  assert.equal(detector.hasSpeech(), false);
});

test('silence and a quiet room never end a turn', () => {
  const detector = createTurnDetector();
  assert.equal(feed(detector, tone(5000, 0.004)), 0);
  assert.equal(detector.hasSpeech(), false);
});

test('a long turn ends at a short breath, and at the latest at the limit', () => {
  const short = createTurnDetector({ longTurnMs: 2000, maxTurnMs: 5000 });
  assert.equal(feed(short, tone(2500, 0.2), silence(200)), 1);

  const endless = createTurnDetector({ longTurnMs: 2000, maxTurnMs: 3000 });
  assert.equal(feed(endless, tone(3200, 0.2)), 1);
});
