/**
 * 16-bit mono PCM as a WAV file — what the fallback hands to Whisper (#859).
 *
 * @param {ArrayBuffer[]} chunks  the recording, in order
 * @param {number} fromByte       where in the recording to begin
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(chunks, fromByte, sampleRate) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  // Whole samples only.
  const from = Math.min(Math.max(0, fromByte - (fromByte % 2)), total);
  const dataBytes = total - from;
  const wav = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wav);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const out = new Uint8Array(wav, 44);
  let seen = 0;
  let written = 0;
  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk);
    const skip = Math.max(0, Math.min(bytes.length, from - seen));
    out.set(bytes.subarray(skip), written);
    written += bytes.length - skip;
    seen += bytes.length;
  }
  return wav;
}
