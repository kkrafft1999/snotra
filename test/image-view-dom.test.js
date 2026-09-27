// Images in the content pane (#345), mounted by the real host against the real
// markup: the channel the bytes come through, the header, every reason an
// image is not shown, fit ↔ actual size, and SVG with its source.
//
// happy-dom neither decodes images nor lays anything out. Where a test needs
// either, it says so: `load()` stands in for Chromium finishing the decode,
// `sized()` gives the column a size. Whether the pixels really arrive is the
// smoke test's question (e2e/smoke.test.mjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const png = (extra = {}) => ({ ok: true, mime: 'image/png', base64: PNG_1PX, size: 2048, mtimeMs: 1, ...extra });
const svg = (markup, extra = {}) => ({
  ok: true,
  mime: 'image/svg+xml',
  base64: Buffer.from(markup, 'utf8').toString('base64'),
  size: markup.length,
  mtimeMs: 1,
  ...extra,
});
const item = (name, extra = {}) => ({ path: `/ws/${name}`, name, size: 2048, modified: 1, ...extra });

async function mountPane(t, { images = {}, files = {} } = {}) {
  const dom = setupRendererDom();
  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const calls = { images: [], files: [] };
  const api = {
    readFile: async (p) => {
      calls.files.push(p);
      return files[p] ?? { error: `ENOENT: ${p}` };
    },
    readWorkspaceImage: async (p) => {
      calls.images.push(p);
      const entry = images[p];
      if (typeof entry === 'function') return entry();
      return entry ?? { ok: false, reason: 'not-found' };
    },
  };
  const host = createFileViewHost({ api, getWorkspaceRoot: () => '/ws' });
  t.after(() => {
    host.dispose();
    dom.cleanup();
  });
  return { host, calls, images };
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function settle() {
  for (let i = 0; i < 4; i += 1) await flush();
}

/** Chromium has decoded the image: natural size, then the load event. */
function load(width, height) {
  const img = $('.img-view__image');
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height });
  img.dispatchEvent(new Event('load'));
}

/** Gives the column a size, as Chromium's layout would. */
function sized(width, height) {
  const view = $('.img-view');
  Object.defineProperty(view, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(view, 'clientHeight', { configurable: true, value: height });
  Object.defineProperty(view, 'scrollWidth', { configurable: true, get: () => parseInt($('.img-view__image').style.width, 10) + 48 });
  Object.defineProperty(view, 'scrollHeight', { configurable: true, get: () => parseInt($('.img-view__image').style.height, 10) + 48 });
}

function message() {
  const box = $('.img-view__message');
  if (!box || box.hidden) return null;
  return {
    title: box.querySelector('.img-view__message-title')?.textContent ?? '',
    detail: box.querySelector('.img-view__message-detail')?.textContent ?? '',
  };
}

test('a PNG comes through fs:readWorkspaceImage as a data: URI, never as text', async (t) => {
  const { host, calls } = await mountPane(t, { images: { '/ws/shot.png': png() } });
  assert.equal(await host.open(item('shot.png')), true);
  await settle();

  assert.equal($('#preview-body > .file-view').dataset.view, 'image');
  assert.deepEqual(calls.images, ['/ws/shot.png']);
  assert.deepEqual(calls.files, [], 'the host does not read an image as text');
  const img = $('.img-view__image');
  assert.equal(img.getAttribute('src'), `data:image/png;base64,${PNG_1PX}`);
  assert.equal(img.alt, 'shot.png', 'the file name is the text alternative');
  assert.equal($('#preview-tools').hidden, true, 'no switch for a raster image');
  assert.equal($('#preview-filename').textContent, 'shot.png');
});

test('the header shows the pixel dimensions next to the size once the image is decoded', async (t) => {
  const { host } = await mountPane(t, { images: { '/ws/shot.png': png({ size: 1536 }) } });
  await host.open(item('shot.png'));
  await settle();

  load(2880, 1800);
  assert.equal($('.img-view__image').hidden, false);
  assert.equal($('#preview-meta').textContent, '1.5 KB · 2880 × 1800');

  // The detail survives a language switch of the header.
  const { setLocale } = await importRenderer('i18n.js');
  t.after(() => setLocale('en', { force: true }));
  setLocale('de', { force: true });
  assert.equal($('#preview-meta').textContent, '1,5 KB · 2880 × 1800');
});

test('every reason from the main process becomes a sentence, not an empty column', async (t) => {
  const cases = [
    ['too-large', 'Too large to preview', /up to 10\.0\u00a0MB .* has 23\.7\u00a0MB/],
    ['unsupported-type', 'Not a readable image', /PNG, JPEG, GIF, WebP or SVG/],
    ['not-found', 'The file cannot be read', /gone/],
    ['outside-workspace', 'Outside the open folder', /points out of the open folder/],
  ];
  for (const [reason, title, detail] of cases) {
    const { host } = await mountPane(t, {
      images: { '/ws/x.png': { ok: false, reason } },
    });
    await host.open(item('x.png', { size: 23.7 * 1024 * 1024 }));
    await settle();
    const shown = message();
    assert.equal(shown?.title, title, reason);
    assert.match(shown.detail, detail, reason);
    assert.equal($('.img-view__message').getAttribute('role'), 'status');
    assert.equal($('.img-view__image').hidden, true, reason);
    assert.equal($('#preview-filename').textContent, 'x.png', 'the header still says which file');
    host.dispose();
  }
});

test('a file that sniffs as an image but does not decode says it is damaged', async (t) => {
  const { host } = await mountPane(t, { images: { '/ws/cut.png': png() } });
  await host.open(item('cut.png'));
  await settle();
  $('.img-view__image').dispatchEvent(new Event('error'));
  assert.equal(message()?.title, 'The image is damaged');
  assert.equal($('.img-view__image').hasAttribute('src'), false);
});

test('the error card follows the interface language', async (t) => {
  const { host } = await mountPane(t, { images: { '/ws/x.png': { ok: false, reason: 'too-large' } } });
  const { setLocale } = await importRenderer('i18n.js');
  t.after(() => setLocale('en', { force: true }));
  await host.open(item('x.png'));
  await settle();
  setLocale('de', { force: true });
  assert.equal(message()?.title, 'Zu groß für die Vorschau');
  assert.match(message().detail, /bis 10,0\u00a0MB/);
});

test('a slow read shows a loading line, and only a slow one', async (t) => {
  let answer;
  const { host } = await mountPane(t, {
    images: { '/ws/big.png': () => new Promise((resolve) => { answer = resolve; }) },
  });
  await host.open(item('big.png'));
  await settle();
  assert.equal(message(), null, 'nothing flickers for a fast read');

  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(message()?.title, 'Loading image…');

  answer(png());
  await settle();
  load(10, 10);
  assert.equal(message(), null);
  assert.equal($('.img-view__image').hidden, false);
});

test('a large image is fitted; click and Enter toggle the actual size and back', async (t) => {
  const { host } = await mountPane(t, { images: { '/ws/shot.png': png() } });
  await host.open(item('shot.png'));
  await settle();
  sized(400, 300);
  load(1600, 1000);

  const view = $('.img-view');
  const img = $('.img-view__image');
  // 400 × 300 minus 24 px padding on each side: 352 × 252 → scale 0.22.
  assert.deepEqual([img.style.width, img.style.height], ['352px', '220px']);
  assert.equal(view.getAttribute('role'), 'button');
  assert.equal(view.tabIndex, 0);
  assert.equal(view.getAttribute('aria-pressed'), 'false');
  assert.equal(view.getAttribute('aria-label'), 'Show shot.png at actual size');
  assert.equal(view.title, 'Click to show at actual size');

  img.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.deepEqual([img.style.width, img.style.height], ['1600px', '1000px']);
  assert.equal(view.getAttribute('aria-pressed'), 'true');
  assert.equal(view.title, 'Click to fit into the column');
  assert.ok(view.classList.contains('img-view--actual'));

  view.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(img.style.width, '352px');
  view.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(img.style.width, '1600px');
  assert.equal(host.runCommand('toggle-source'), false, 'a PNG has no source to switch to');
});

test('an image that fits is never upscaled and has nothing to toggle', async (t) => {
  const { host } = await mountPane(t, { images: { '/ws/favicon.png': png() } });
  await host.open(item('favicon.png'));
  await settle();
  sized(400, 300);
  load(16, 16);

  const view = $('.img-view');
  const img = $('.img-view__image');
  assert.deepEqual([img.style.width, img.style.height], ['16px', '16px']);
  assert.equal(view.hasAttribute('role'), false);
  assert.equal(view.hasAttribute('tabindex'), false);
  img.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(img.style.width, '16px');
});

test('a refresh with unchanged bytes keeps the image; a changed file replaces it', async (t) => {
  const { host, images, calls } = await mountPane(t, { images: { '/ws/plot.png': png() } });
  await host.open(item('plot.png'));
  await settle();
  sized(400, 300);
  load(1600, 1000);
  $('.img-view__image').dispatchEvent(new MouseEvent('click', { bubbles: true }));

  await host.refresh('/ws/plot.png');
  await settle();
  assert.equal(calls.images.length, 2);
  assert.equal($('.img-view__image').style.width, '1600px', 'still at actual size');

  images['/ws/plot.png'] = png({ base64: 'AAAA', mtimeMs: 2 });
  await host.refresh('/ws/plot.png');
  await settle();
  assert.equal($('.img-view__image').getAttribute('src'), 'data:image/png;base64,AAAA');
});

test('an SVG shows as an image with the size it declares, and switches to its source', async (t) => {
  const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 170"><script>alert(1)</script></svg>';
  const { host, calls } = await mountPane(t, {
    images: { '/ws/flow.svg': svg(markup) },
    files: { '/ws/flow.svg': { content: markup, size: markup.length, modified: 1 } },
  });
  await host.open(item('flow.svg'));
  await settle();

  assert.match($('.img-view__image').getAttribute('src'), /^data:image\/svg\+xml;base64,/);
  assert.equal(document.querySelector('#preview-body svg'), null, 'the SVG is never inlined into the DOM');
  load(300, 150);
  assert.match($('#preview-meta').textContent, / · 720 × 170$/, 'the viewBox, not Chromium\'s default 300 × 150');

  const radios = $$('#preview-tools input[type="radio"]');
  assert.deepEqual(radios.map((r) => [r.value, r.checked]), [['preview', true], ['source', false]]);
  assert.deepEqual($$('#preview-tools .ds-segmented__option').map((l) => l.textContent), ['Preview', 'Source']);
  assert.deepEqual(calls.files, [], 'the source is only read when asked for');

  radios[1].checked = true;
  radios[1].dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(calls.files, ['/ws/flow.svg']);
  assert.equal($('#preview-content').textContent, markup);
  assert.equal($('.img-view').hidden, true);

  assert.equal(host.runCommand('toggle-source'), true, 'the menu shortcut works for SVG too');
  assert.equal($('.img-view').hidden, false);
  assert.equal($('.md-source').hidden, true);
});

test('svgDimensions reads width and height in pixels, else the viewBox', async () => {
  const dom = setupRendererDom();
  try {
    const { svgDimensions } = await importRenderer('file-views', 'image-view.js');
    const ns = 'xmlns="http://www.w3.org/2000/svg"';
    assert.deepEqual(svgDimensions(`<svg ${ns} width="64" height="32"/>`), { width: 64, height: 32 });
    assert.deepEqual(svgDimensions(`<svg ${ns} width="64px" height="32px" viewBox="0 0 8 4"/>`), { width: 64, height: 32 });
    assert.deepEqual(svgDimensions(`<svg ${ns} viewBox="0 0 720 170"/>`), { width: 720, height: 170 });
    assert.deepEqual(svgDimensions(`<svg ${ns} width="100" viewBox="0,0,200,50"/>`), { width: 100, height: 25 });
    assert.deepEqual(svgDimensions(`<svg ${ns} width="100%" height="10cm" viewBox="0 0 30 20"/>`), { width: 30, height: 20 });
    assert.equal(svgDimensions(`<svg ${ns}/>`), null);
    assert.equal(svgDimensions('<html/>'), null);
  } finally {
    dom.cleanup();
  }
});

test('fitScale never goes above 1 and has no answer without a column', async () => {
  const { fitScale } = await importRenderer('file-views', 'image-view.js');
  assert.equal(fitScale({ width: 100, height: 100 }, { width: 400, height: 400 }), 1);
  assert.equal(fitScale({ width: 800, height: 200 }, { width: 400, height: 400 }), 0.5);
  assert.equal(fitScale({ width: 100, height: 800 }, { width: 400, height: 400 }), 0.5);
  assert.equal(fitScale({ width: 100, height: 100 }, { width: 0, height: 400 }), null);
  assert.equal(fitScale(null, { width: 400, height: 400 }), null);
});
