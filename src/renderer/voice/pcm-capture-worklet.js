// Runs in the AudioWorkletGlobalScope (#859), where `sampleRate`,
// `AudioWorkletProcessor` and `registerProcessor` are globals.
//
// Turns the microphone's float samples into 16-bit PCM and hands them to the
// page in chunks of 100 ms, each with its loudness for the level meter. The
// context runs at 24 kHz, the rate the transcription is opened with; Chromium
// resamples the microphone to it.

const CHUNK_MS = 100;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round((sampleRate * CHUNK_MS) / 1000);
    this.chunk = new Int16Array(this.size);
    this.filled = 0;
    this.squares = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      const value = Math.max(-1, Math.min(1, channel[i]));
      this.chunk[this.filled] = value < 0 ? value * 0x8000 : value * 0x7fff;
      this.squares += value * value;
      this.filled += 1;
      if (this.filled === this.size) {
        const pcm = this.chunk.buffer;
        this.port.postMessage({ pcm, level: Math.sqrt(this.squares / this.size) }, [pcm]);
        this.chunk = new Int16Array(this.size);
        this.filled = 0;
        this.squares = 0;
      }
    }
    return true;
  }
}

registerProcessor('snotra-pcm-capture', PcmCaptureProcessor);
