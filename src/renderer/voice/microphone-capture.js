import contracts from '../generated/contracts.js';

/**
 * The microphone as a stream of 16-bit PCM chunks (#859).
 *
 * Resolves once the microphone is open; `onChunk(pcm, level)` then receives
 * 100 ms of audio at a time as an ArrayBuffer, with its loudness from 0 to 1.
 * `stop()` releases the microphone and the audio context — the red dot in the
 * menu bar goes out with it. Rejects with the error of `getUserMedia` (a
 * `NotAllowedError` when access was refused) or of the audio graph.
 */
export async function openMicrophone({ onChunk }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let context = null;
  try {
    context = new AudioContext({ sampleRate: contracts.VOICE_SAMPLE_RATE });
    await context.audioWorklet.addModule(new URL('./pcm-capture-worklet.js', import.meta.url));
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'snotra-pcm-capture');
    capture.port.onmessage = ({ data }) => {
      if (data?.pcm) onChunk(data.pcm, data.level);
    };
    // The processor has to be pulled by the graph to run; it writes nothing,
    // so nothing is heard.
    source.connect(capture).connect(context.destination);
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => {});
    throw err;
  }

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
      void context.close().catch(() => {});
    },
  };
}
