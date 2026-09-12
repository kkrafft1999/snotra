'use strict';

/**
 * Ausgabe eines Kindprozesses bis zu einer Obergrenze sammeln (Issue #86/#102).
 *
 * Was darueber hinausgeht, wird verworfen statt gepuffert — ein Skript oder
 * ein Build, das Megabytes ausgibt, soll weder den Speicher noch das
 * Kontextfenster fluten. Gemeinsam genutzt von Python- und Shell-Runner,
 * damit beide dieselbe Kappungsmarkierung liefern.
 */
function createOutputSink(maxBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    get truncated() {
      return truncated;
    },
    text() {
      const text = Buffer.concat(chunks).toString('utf8');
      return truncated ? `${text}\n… [Ausgabe gekürzt]` : text;
    },
  };
}

module.exports = { createOutputSink };
