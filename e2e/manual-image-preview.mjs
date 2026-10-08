// Look instead of trust: images in the file preview (#345), every state from
// the definition of done in the real app, light and dark. Not a test — the
// smoke test checks what must hold; this one produces the pictures for the
// pull request and prints what a picture cannot show (sizes, focus, requests).
//
//   node e2e/manual-image-preview.mjs [label]
//
// Result: out/mockup/image-<label>-<state>-<theme>.png, label defaults to
// "current".

import { mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const label = process.argv[2] || 'current';
const SHOTS = path.resolve('out/mockup');

// ── Fixtures: real files, written byte by byte ──────────────────────────────

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
function makePng(width, height, paint) {
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

/** A screenshot-like picture of a window: title bar, sidebar, lines of text. */
const screenshot = () => makePng(2880, 1800, (x, y) => {
  if (y < 96) return x < 200 && y > 32 && y < 64 && [60, 110, 160].some((cx) => Math.abs(x - cx) < 16)
    ? [255, 95, 87, 255] : [233, 228, 220, 255];
  if (x < 560) {
    const row = Math.floor((y - 170) / 80);
    return row >= 0 && (y - 170) % 80 < 28 && x > 48 && x < 348 + ((row * 53) % 160) ? [217, 211, 202, 255] : [242, 237, 230, 255];
  }
  if (y > 170 && y < 226 && x > 620 && x < 2120) return [0, 117, 158, 255];
  const line = Math.floor((y - 280) / 64);
  if (line >= 0 && (y - 280) % 64 < 24 && x > 620 && x < 1520 + ((line * 211) % 1100)) return [227, 221, 212, 255];
  return [255, 252, 245, 255];
});

/** A dark logo on nothing: a triangle with a blue disc — the transparency case. */
const logo = () => makePng(512, 512, (x, y) => {
  const dx = x - 256;
  const dy = y - 300;
  if (dx * dx + dy * dy < 70 * 70) return [0, 117, 158, 255];
  const inTriangle = y > 40 && y < 440 && Math.abs(x - 256) < ((y - 40) / 400) * 216;
  return inTriangle ? [31, 30, 28, 255] : [0, 0, 0, 0];
});

const favicon = () => makePng(16, 16, (x, y) => {
  const inside = x > 0 && x < 15 && y > 0 && y < 15;
  if (!inside) return [0, 0, 0, 0];
  const bar = (y === 4 || y === 5) && x > 3 && x < 12;
  const bar2 = (y === 8 || y === 9) && x > 3 && x < 9;
  return bar || bar2 ? [255, 255, 255, 255] : [0, 117, 158, 255];
});

/**
 * An animated GIF: a blue square travelling across a light strip. The LZW
 * stream sends a clear code after every second pixel, so the code size never
 * grows — large, but trivially correct.
 */
function animatedGif(width = 160, height = 60, frames = 8) {
  const palette = Buffer.from([255, 252, 245, 0, 117, 158, 31, 30, 28, 242, 237, 230]);
  const header = Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([width & 0xff, width >> 8, height & 0xff, height >> 8, 0xf1, 0, 0]),
    palette,
    // Loop forever.
    Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, 0, 0, 0]),
  ]);
  const parts = [header];
  for (let f = 0; f < frames; f += 1) {
    const left = 10 + f * 17;
    const pixels = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixels.push(x >= left && x < left + 30 && y >= 15 && y < 45 ? 1 : (y === 0 || y === height - 1 ? 3 : 0));
      }
    }
    // LZW, min code size 2: clear = 4, end = 5, codes are 3 bits wide.
    const codes = [];
    for (let i = 0; i < pixels.length; i += 2) {
      codes.push(4, pixels[i]);
      if (i + 1 < pixels.length) codes.push(pixels[i + 1]);
    }
    codes.push(5);
    const bytes = [];
    let acc = 0;
    let bits = 0;
    for (const code of codes) {
      acc |= code << bits;
      bits += 3;
      while (bits >= 8) {
        bytes.push(acc & 0xff);
        acc >>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) bytes.push(acc & 0xff);
    const blocks = [];
    for (let i = 0; i < bytes.length; i += 255) {
      const slice = bytes.slice(i, i + 255);
      blocks.push(Buffer.from([slice.length, ...slice]));
    }
    parts.push(
      Buffer.from([0x21, 0xf9, 4, 0, 12, 0, 0, 0]), // 120 ms per frame
      Buffer.from([0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0]),
      Buffer.from([2]),
      ...blocks,
      Buffer.from([0]),
    );
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

const FLOW_SVG = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!-- A diagram as an agent would write it (#85) -->',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 170">',
  '  <script>window.__pwnedSvg = true</script>',
  '  <image href="https://snotra-smoke.invalid/tracker.png" width="1" height="1"/>',
  '  <defs><marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">',
  '    <path d="M0 0 L10 5 L0 10 z" fill="#00759E"/></marker></defs>',
  '  <rect x="20" y="40" width="200" height="90" rx="12" fill="#E6F1F5" stroke="#00759E" stroke-width="3"/>',
  '  <text x="120" y="93" text-anchor="middle" font-family="Helvetica" font-size="22" fill="#1F1E1C">Renderer</text>',
  '  <rect x="500" y="40" width="200" height="90" rx="12" fill="#E6F1F5" stroke="#00759E" stroke-width="3"/>',
  '  <text x="600" y="93" text-anchor="middle" font-family="Helvetica" font-size="22" fill="#1F1E1C">Main</text>',
  '  <path d="M224 85 H494" stroke="#00759E" stroke-width="3" marker-end="url(#a)"/>',
  '  <text x="360" y="72" text-anchor="middle" font-family="Menlo" font-size="16" fill="#5E5C59">fs:readWorkspaceImage</text>',
  '</svg>',
  '',
].join('\n');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-images-');
const outside = await makeTempDir('snotra-images-outside-');
const userDataDir = await makeTempDir('snotra-images-userdata-');
await mkdir(SHOTS, { recursive: true });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const files = {
  'screenshot-2026-09-27.png': screenshot(),
  'assets/logo.png': logo(),
  'assets/favicon-16.png': favicon(),
  'assets/loader.gif': animatedGif(),
  'docs/ipc-flow.svg': FLOW_SVG,
  // Header right, content cut off: sniffs as PNG, does not decode.
  'broken/cut.png': Buffer.concat([PNG_SIGNATURE, Buffer.from('not the rest of a png')]),
  // A text file with an image name.
  'broken/plot.png': 'x,y\n1,2\n',
  // Over the 10 MB limit — the size alone decides, the content is never read.
  'render/hero-8k.png': Buffer.concat([PNG_SIGNATURE, Buffer.alloc(11 * 1024 * 1024)]),
};
for (const [name, content] of Object.entries(files)) {
  const file = path.join(workspace, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
await writeFile(path.join(outside, 'secret.png'), logo());
await symlink(path.join(outside, 'secret.png'), path.join(workspace, 'broken', 'outside.png'));

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const requests = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith('data:') && !url.startsWith('file:') && !url.startsWith('devtools:')) requests.push(url);
});

const pane = () => page.evaluate(() => {
  const img = document.querySelector('.img-view__image');
  const message = document.querySelector('.img-view__message');
  return {
    name: document.getElementById('preview-filename').textContent,
    view: document.querySelector('#preview-body > .file-view')?.dataset.view ?? null,
    meta: document.getElementById('preview-meta').textContent,
    visible: Boolean(img && !img.hidden && img.naturalWidth > 0 && img.style.width),
    size: img ? `${img.style.width} × ${img.style.height}` : null,
    message: message && !message.hidden ? message.textContent : null,
  };
});

async function openPath(...names) {
  for (const name of names) {
    await page.evaluate((fileName) => {
      [...document.querySelectorAll('#tree-container .tree-item')]
        .find((el) => el.querySelector('.label')?.textContent === fileName)
        ?.click();
    }, name);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function openAndWait(name, ready, what) {
  await openPath(name);
  return poll(async () => {
    const state = await pane();
    return state.name === name && ready(state) ? state : null;
  }, { what: what ?? name });
}

async function shoot(state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 150));
    await page.locator('#content').screenshot({ path: path.join(SHOTS, `image-${label}-${state}-${theme}.png`) });
  }
}

try {
  await poll(
    async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'tree' }
  );
  await page.setViewportSize?.({ width: 1440, height: 900 });

  const shot = await openAndWait('screenshot-2026-09-27.png', (s) => s.visible);
  console.log('screenshot, fitted:', shot);
  await shoot('screenshot-fit');

  // The header zooms (#803): two steps up, then the image is larger than the
  // column and shows the hand.
  await page.click('#preview-tools .pdf-tools__zoom-in');
  await page.click('#preview-tools .pdf-tools__zoom-in');
  await new Promise((r) => setTimeout(r, 150));
  const viewState = () => page.evaluate(() => {
    const view = document.querySelector('.img-view');
    return {
      zoom: document.querySelector('#preview-tools .pdf-tools__zoom')?.textContent,
      fitPressed: document.querySelector('#preview-tools .pdf-tools__fit')?.getAttribute('aria-pressed'),
      pannable: view.classList.contains('img-view--pannable'),
      cursor: getComputedStyle(view).cursor,
      label: view.getAttribute('aria-label'),
      scroll: [view.scrollLeft, view.scrollTop, view.scrollWidth, view.scrollHeight],
      focus: document.activeElement === view,
    };
  });
  console.log('screenshot, zoomed:', await pane(), await viewState());
  await shoot('screenshot-zoomed');

  // A left-button drag moves it; the cursor closes into a fist meanwhile.
  const box = await page.locator('.img-view').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2 - 120, { steps: 8 });
  console.log('while dragging:', await viewState());
  await shoot('screenshot-dragging');
  await page.mouse.up();
  console.log('after the drag:', await viewState());

  // Keyboard: the arrow keys scroll the focused view, Cmd+0 fits again.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await new Promise((r) => setTimeout(r, 150));
  console.log('after arrows:', await viewState());
  await shoot('screenshot-zoomed-focus');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+0' : 'Control+0');
  await new Promise((r) => setTimeout(r, 150));
  console.log('after Cmd+0:', await viewState());

  await openPath('assets');
  console.log('logo:', await openAndWait('logo.png', (s) => s.visible));
  await shoot('logo-transparent');
  console.log('favicon:', await openAndWait('favicon-16.png', (s) => s.visible));
  await shoot('tiny');
  console.log('gif:', await openAndWait('loader.gif', (s) => s.visible));
  await shoot('animated-gif');

  await openPath('docs');
  console.log('svg:', await openAndWait('ipc-flow.svg', (s) => s.visible));
  await shoot('svg');
  for (let i = 0; i < 4; i += 1) await page.click('#preview-tools .pdf-tools__zoom-in');
  await new Promise((r) => setTimeout(r, 150));
  console.log('svg zoomed:', await viewState());
  await shoot('svg-zoomed');
  await page.click('#preview-tools .pdf-tools__fit');
  await page.focus('.file-view-mode-switch input:checked');
  await page.keyboard.press('ArrowRight');
  await poll(async () => page.evaluate(() => {
    const pre = document.getElementById('preview-content');
    return Boolean(pre && pre.offsetParent && pre.textContent.startsWith('<?xml'));
  }), { what: 'svg source' });
  await shoot('svg-source');
  console.log('svg script ran:', await page.evaluate(() => globalThis.__pwnedSvg ?? null));

  await openPath('render');
  console.log('too large:', await openAndWait('hero-8k.png', (s) => Boolean(s.message)));
  await shoot('too-large');
  await openPath('broken');
  console.log('damaged:', await openAndWait('cut.png', (s) => Boolean(s.message)));
  await shoot('damaged');
  console.log('not an image:', await openAndWait('plot.png', (s) => Boolean(s.message)));
  await shoot('not-an-image');
  console.log('symlink outside:', await openAndWait('outside.png', (s) => Boolean(s.message)));
  await shoot('outside');

  // A narrow column: the fit follows the column.
  await openAndWait('screenshot-2026-09-27.png', (s) => s.visible);
  await page.evaluate(() => {
    const content = document.getElementById('content');
    content.style.flex = '0 0 380px';
    content.style.maxWidth = '380px';
  });
  await new Promise((r) => setTimeout(r, 300));
  console.log('narrow:', await pane());
  await shoot('narrow');

  console.log('requests outside file:/data::', requests);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
