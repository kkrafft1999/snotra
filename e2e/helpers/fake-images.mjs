// OpenAI's Images API, answered inside the app's main process (#85).
//
// The image adapter looks `fetch` up on every call, like the providers do, so
// a wrapper around the global `fetch` sees its requests without a hook in the
// app. Only the two addresses the image feature uses are answered here; every
// other request passes through untouched. Nothing reaches OpenAI.

import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** An RGBA PNG; `paint(x, y)` returns [r, g, b, a]. */
export function makePng(width, height, paint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) raw.set(paint(x, y), y * stride + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A picture that reads as one at thumbnail size: a dusk sky, a sun and two
 * layers of hills — so a screenshot shows whether the image is framed right,
 * not a flat colour that hides cropping.
 */
export function landscapePng(width = 768, height = 512) {
  const hill = (x, base, amp, freq, phase) => base + amp * Math.sin((x / width) * Math.PI * freq + phase);
  return makePng(width, height, (x, y) => {
    if (y > hill(x, height * 0.78, height * 0.05, 3, 1.2)) return [38, 70, 83, 255];
    if (y > hill(x, height * 0.66, height * 0.07, 2, 0.3)) return [42, 157, 143, 255];
    const dx = x - width * 0.68;
    const dy = y - height * 0.42;
    if (dx * dx + dy * dy < (height * 0.11) ** 2) return [244, 162, 97, 255];
    const t = y / (height * 0.7);
    return [Math.round(233 - 40 * t), Math.round(196 - 60 * t), Math.round(106 + 80 * t), 255];
  });
}

/**
 * Answers the image requests of the app in `app` (a Playwright Electron
 * application). Returns a reader for what the app asked.
 *
 * @param {import('playwright').ElectronApplication} app
 * @param {{ image?: Buffer, models?: string[], status?: number, error?: object, delayMs?: number }} [options]
 */
export async function routeOpenAiImages(app, options = {}) {
  const image = (options.image || landscapePng()).toString('base64');
  await app.evaluate((_electron, setup) => {
    const original = globalThis.__snotraOriginalFetch ?? globalThis.fetch;
    globalThis.__snotraOriginalFetch = original;
    globalThis.__imageRequests = [];
    globalThis.__imageSetup = setup;
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url;
      const current = globalThis.__imageSetup;
      const json = (status, body) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
      if (url === 'https://api.openai.com/v1/images/generations') {
        const body = JSON.parse(init.body || '{}');
        globalThis.__imageRequests.push({ url, body, auth: init.headers?.Authorization ?? null });
        if (current.delayMs) await new Promise((resolve) => setTimeout(resolve, current.delayMs));
        if (current.status && current.status !== 200) return json(current.status, current.error || { error: { message: 'fake failure' } });
        return json(200, { created: 0, data: [{ b64_json: current.image }] });
      }
      if (url === 'https://api.openai.com/v1/models') {
        return json(200, { data: current.models.map((id) => ({ id })) });
      }
      return original(input, init);
    };
  }, {
    image,
    models: options.models || ['gpt-5.5', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
    status: options.status || 200,
    error: options.error || null,
    delayMs: options.delayMs || 0,
  });
  return {
    requests: () => app.evaluate(() => globalThis.__imageRequests ?? []),
    /** Changes what the next requests get, e.g. `{ status: 400, error }`. */
    update: (patch) => app.evaluate((_electron, next) => {
      globalThis.__imageSetup = { ...globalThis.__imageSetup, ...next };
    }, patch),
  };
}
