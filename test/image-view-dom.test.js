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
  assert.equal($('#preview-tools input[type="radio"]'), null, 'no Preview | Source switch for a raster image');
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

/** The zoom group in the header, once a picture is on show (#803). */
function zoomTools() {
  return {
    out: $('#preview-tools .pdf-tools__zoom-out'),
    value: $('#preview-tools .pdf-tools__zoom'),
    in: $('#preview-tools .pdf-tools__zoom-in'),
    fit: $('#preview-tools .pdf-tools__fit'),
  };
}

function pointer(type, { x = 0, y = 0, button = 0 } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

test('a large image is fitted; the header zooms it, a click does not (#803)', async (t) => {
  const { host } = await mountPane(t, { images: { '/ws/shot.png': png() } });
  await host.open(item('shot.png'));
  await settle();
  sized(400, 300);
  load(1600, 1000);

  const view = $('.img-view');
  const img = $('.img-view__image');
  // 400 × 300 minus 24 px padding on each side: 352 × 252 → scale 0.22.
  assert.deepEqual([img.style.width, img.style.height], ['352px', '220px']);
  const tools = zoomTools();
  assert.equal($('#preview-tools').hidden, false);
  assert.equal(tools.value.textContent, '22\u00a0%');
  assert.equal(tools.fit.textContent, 'Fit');
  assert.equal(tools.fit.getAttribute('aria-pressed'), 'true');
  assert.equal(tools.out.getAttribute('aria-label'), 'Zoom out');
  assert.equal(view.classList.contains('img-view--pannable'), false, 'fitted, there is nothing to move');

  img.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(img.style.width, '352px', 'a click no longer zooms');

  tools.in.click();
  assert.deepEqual([img.style.width, img.style.height], ['400px', '250px'], 'the next step above 22 %: 25 %');
  assert.equal(tools.fit.getAttribute('aria-pressed'), 'false');
  assert.equal($('.img-view__announcer').textContent, '25\u00a0%');
  assert.ok(view.classList.contains('img-view--pannable'));
  assert.equal(view.tabIndex, 0);
  assert.equal(view.getAttribute('aria-label'), 'shot.png, move with the arrow keys');
  assert.equal(view.title, 'Drag to move');

  view.dispatchEvent(new KeyboardEvent('keydown', { key: '0', metaKey: true, bubbles: true }));
  assert.equal(img.style.width, '352px', 'Cmd+0 fits again');
  assert.equal(view.tabIndex, 0, 'still focusable for the zoom keys');
  assert.equal(view.getAttribute('aria-label'), 'shot.png', 'nothing to move, so no arrow keys named');
  assert.equal(view.hasAttribute('title'), false);
  view.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }));
  view.dispatchEvent(new KeyboardEvent('keydown', { key: '+', metaKey: true, bubbles: true }));
  assert.equal(img.style.width, '528px', '25 %, then 33 %');
  view.dispatchEvent(new KeyboardEvent('keydown', { key: '-', metaKey: true, bubbles: true }));
  assert.equal(img.style.width, '400px');
  assert.equal(zoomTools().out.disabled, true, '25 % is the smallest step');
  assert.equal(host.runCommand('toggle-source'), false, 'a PNG has no source to switch to');
});

test('a zoomed image is moved by dragging with the left button', async (t) => {
  const { host } = await mountPane(t, { images: { '/ws/map.png': png() } });
  await host.open(item('map.png'));
  await settle();
  sized(400, 300);
  load(1600, 1000);
  for (let i = 0; i < 20; i += 1) zoomTools().in.click();
  const view = $('.img-view');
  assert.equal(zoomTools().value.textContent, '400\u00a0%');
  assert.equal(zoomTools().in.disabled, true);
  view.scrollLeft = 100;
  view.scrollTop = 50;

  view.dispatchEvent(pointer('pointerdown', { x: 200, y: 200, button: 2 }));
  assert.equal(view.classList.contains('img-view--dragging'), false, 'only the left button grabs');

  view.dispatchEvent(pointer('pointerdown', { x: 200, y: 200 }));
  assert.ok(view.classList.contains('img-view--dragging'));
  view.dispatchEvent(pointer('pointermove', { x: 170, y: 180 }));
  assert.deepEqual([view.scrollLeft, view.scrollTop], [130, 70], 'the image follows the hand');
  view.dispatchEvent(pointer('pointerup', { x: 170, y: 180 }));
  assert.equal(view.classList.contains('img-view--dragging'), false);
  view.dispatchEvent(pointer('pointermove', { x: 0, y: 0 }));
  assert.deepEqual([view.scrollLeft, view.scrollTop], [130, 70], 'released, it stays');
});

test('an image that fits is never upscaled and cannot be dragged', async (t) => {
  const { host } = await mountPane(t, { images: { '/ws/favicon.png': png() } });
  await host.open(item('favicon.png'));
  await settle();
  sized(400, 300);
  load(16, 16);

  const view = $('.img-view');
  const img = $('.img-view__image');
  assert.deepEqual([img.style.width, img.style.height], ['16px', '16px']);
  assert.equal(zoomTools().value.textContent, '100\u00a0%');
  assert.equal(view.classList.contains('img-view--pannable'), false);
  assert.equal(view.hasAttribute('title'), false);
  view.dispatchEvent(pointer('pointerdown', { x: 10, y: 10 }));
  assert.equal(view.classList.contains('img-view--dragging'), false);
  zoomTools().in.click();
  assert.equal(img.style.width, '18px', 'upscaled only when asked for, from the header');
});

test('a refresh with unchanged bytes keeps the image; a changed file replaces it', async (t) => {
  const { host, images, calls } = await mountPane(t, { images: { '/ws/plot.png': png() } });
  await host.open(item('plot.png'));
  await settle();
  sized(400, 300);
  load(1600, 1000);
  zoomTools().in.click();

  await host.refresh('/ws/plot.png');
  await settle();
  assert.equal(calls.images.length, 2);
  assert.equal($('.img-view__image').style.width, '400px', 'still at the chosen zoom');

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
  assert.equal(zoomTools().fit, null, 'no zoom while the source is on show');

  assert.equal(host.runCommand('toggle-source'), true, 'the menu shortcut works for SVG too');
  assert.ok(zoomTools().fit, 'the zoom is back next to the switch');
  assert.equal($('.img-view').hidden, false);
  assert.equal($('.md-source').hidden, true);
});

/** Switches an SVG to its source, as the header control does. */
async function showSource() {
  const source = $$('#preview-tools input[type="radio"]')[1];
  source.checked = true;
  source.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

function sourceMessage() {
  const box = $('.img-source__message');
  if (!box || box.hidden) return null;
  return {
    title: box.querySelector('.img-view__message-title')?.textContent ?? '',
    detail: box.querySelector('.img-view__message-detail')?.textContent ?? '',
  };
}

test('an SVG whose source cannot be read says why instead of showing the error as its text (#641)', async (t) => {
  const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>';
  const { host } = await mountPane(t, {
    images: { '/ws/big.svg': svg(markup, { size: 3 * 1024 * 1024 }) },
    // Between the 1 MB text limit and the 10 MB image limit.
    files: { '/ws/big.svg': { error: 'File too large for preview', reason: 'too-large', size: 3 * 1024 * 1024 } },
  });
  const { setLocale } = await importRenderer('i18n.js');
  t.after(() => setLocale('en', { force: true }));
  await host.open(item('big.svg'));
  await settle();
  await showSource();

  assert.deepEqual(sourceMessage(), {
    title: 'Source not available',
    detail: 'This file is too large to show as text.',
  });
  assert.equal($('#preview-content'), null, 'no monospace pane with an error in it');
  assert.equal($('.img-source__message').getAttribute('role'), 'status');

  setLocale('de', { force: true });
  assert.deepEqual(sourceMessage(), {
    title: 'Quelltext nicht verfügbar',
    detail: 'Diese Datei ist zu groß, um sie als Text zu zeigen.',
  });
});

test('a deleted SVG says so in its source pane, and the text comes back with the file', async (t) => {
  const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>';
  const files = { '/ws/flow.svg': { content: markup, size: markup.length, modified: 1 } };
  const { host } = await mountPane(t, { images: { '/ws/flow.svg': svg(markup) }, files });
  await host.open(item('flow.svg'));
  await settle();
  await showSource();
  assert.equal($('#preview-content').textContent, markup);

  files['/ws/flow.svg'] = { error: "ENOENT: no such file or directory, open '/ws/flow.svg'", reason: 'missing' };
  await host.refresh('/ws/flow.svg');
  await settle();
  assert.equal(sourceMessage().detail, 'This file is no longer there. It was moved, renamed or deleted.');
  assert.equal($('.img-source__text').hidden, true);

  files['/ws/flow.svg'] = { content: `${markup}\n`, size: markup.length + 1, modified: 2 };
  await host.refresh('/ws/flow.svg');
  await settle();
  assert.equal(sourceMessage(), null);
  assert.equal($('.img-source__text').hidden, false);
  assert.equal($('#preview-content').textContent, `${markup}\n`);
});

test('of two reads of an SVG source the newer one wins (#641)', async (t) => {
  const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>';
  const answers = [];
  const files = {};
  const { host } = await mountPane(t, { images: { '/ws/flow.svg': svg(markup) }, files });
  await host.open(item('flow.svg'));
  await settle();
  // Every read of the source waits until the test answers it.
  Object.defineProperty(files, '/ws/flow.svg', {
    get: () => new Promise((resolve) => answers.push(resolve)),
  });

  await showSource();
  const refreshed = host.refresh('/ws/flow.svg');
  await settle();
  assert.equal(answers.length, 2, 'one read for the switch, one for the refresh');
  answers[1]({ content: 'new', size: 3, modified: 2 });
  await settle();
  answers[0]({ content: 'old', size: 3, modified: 1 });
  await refreshed;
  await settle();
  assert.equal($('#preview-content').textContent, 'new');
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
