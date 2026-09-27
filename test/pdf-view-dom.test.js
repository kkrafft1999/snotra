// PDFs in the content pane (#346), mounted by the real host against the real
// markup. pdf.js itself is replaced: happy-dom has neither a canvas that draws
// nor a worker, and what pdf.js does with a real file is the smoke test's
// question (e2e/smoke.test.mjs). What is tested here is everything around
// it: the channel, the header tools, every state, the password flow, zoom and
// paging, and letting go of the document.
//
// Without IntersectionObserver the view draws the first two pages, as a
// viewport would show them; the tests rely on that.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const item = (name, extra = {}) => ({ path: `/ws/${name}`, name, size: 4096, modified: 1, ...extra });
const pdfBytes = (extra = {}) => ({ ok: true, bytes: new Uint8Array([37, 80, 68, 70, 45]), size: 13312, mtimeMs: 1, ...extra });

/** A pdf.js document stand-in: A4 pages that "render" at once. */
function fakeDocument({ pages = 3, failPage = null, sizes = {} } = {}) {
  const renders = [];
  return {
    numPages: pages,
    renders,
    async getPage(n) {
      const size = sizes[n] ?? { width: 595, height: 842 };
      return {
        getViewport: ({ scale }) => ({ width: size.width * scale, height: size.height * scale }),
        render: ({ canvas, viewport }) => {
          renders.push({ page: n, width: canvas.width, scale: viewport.width / size.width });
          return {
            promise: n === failPage ? Promise.reject(new Error('bad page')) : Promise.resolve(),
            cancel() {},
          };
        },
      };
    },
  };
}

async function mountPane(t, { pdfs = {}, open } = {}) {
  const dom = setupRendererDom();
  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const { createFileViewRegistry } = await importRenderer('file-views', 'registry.js');
  const { createPdfView } = await importRenderer('file-views', 'pdf-view.js');
  const calls = { pdfs: [], files: [], opened: 0, destroyed: 0 };
  const openDocument = async (api, bytes, options) => {
    calls.opened += 1;
    const promise = open ? open(bytes, options, calls) : Promise.resolve(fakeDocument());
    return { promise, destroy: () => { calls.destroyed += 1; } };
  };
  const api = {
    readFile: async (p) => {
      calls.files.push(p);
      return { error: 'not text' };
    },
    readWorkspacePdf: async (p) => {
      calls.pdfs.push(p);
      const entry = pdfs[p];
      if (typeof entry === 'function') return entry();
      return entry ?? { ok: false, reason: 'not-found' };
    },
  };
  const host = createFileViewHost({
    api,
    registry: createFileViewRegistry([createPdfView({ openDocument })]),
    getWorkspaceRoot: () => '/ws',
  });
  t.after(() => {
    host.dispose();
    dom.cleanup();
  });
  return { host, calls, pdfs };
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function settle() {
  for (let i = 0; i < 8; i += 1) await flush();
}

function message() {
  const box = $('.pdf-view__message');
  if (!box || box.hidden) return null;
  return {
    title: box.querySelector('.pdf-view__message-title')?.textContent ?? '',
    detail: box.querySelector('.pdf-view__message-detail')?.textContent ?? '',
  };
}

function press(el, key) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

test('a PDF comes through fs:readWorkspacePdf, never as text, and shows its pages', async (t) => {
  const { host, calls } = await mountPane(t, { pdfs: { '/ws/spec.pdf': pdfBytes() } });
  assert.equal(await host.open(item('spec.pdf')), true);
  await settle();

  assert.equal($('#preview-body > .file-view').dataset.view, 'pdf');
  assert.deepEqual(calls.pdfs, ['/ws/spec.pdf']);
  assert.deepEqual(calls.files, [], 'the host does not read a PDF as text');
  assert.equal($('.pdf-view').hidden, false);
  assert.equal($('.pdf-view').getAttribute('aria-label'), 'spec.pdf');
  assert.equal($$('.pdf-page').length, 3, 'a placeholder per page from the start');
  assert.deepEqual($$('.pdf-page').map((p) => p.getAttribute('aria-label')), ['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);
  assert.deepEqual($$('.pdf-page canvas').map((c) => c.closest('.pdf-page').dataset.page), ['1', '2']);
  assert.equal($('#preview-meta').textContent, '13.0 KB · 3 pages');
});

test('the header carries page and zoom, labelled for a screen reader', async (t) => {
  const { host } = await mountPane(t, { pdfs: { '/ws/spec.pdf': pdfBytes() } });
  await host.open(item('spec.pdf'));
  await settle();

  const tools = $('#preview-tools');
  assert.equal(tools.hidden, false);
  const [pager, zoom] = [...tools.children];
  assert.equal(pager.getAttribute('aria-label'), 'Page');
  assert.equal(zoom.getAttribute('aria-label'), 'Zoom');
  assert.equal($('.pdf-tools__page').value, '1');
  assert.equal($('.pdf-tools__page').getAttribute('aria-label'), 'Go to page, 1 to 3');
  assert.equal($('.pdf-tools__total').textContent, '/ 3');
  assert.equal($('.pdf-tools__prev').disabled, true);
  assert.equal($('.pdf-tools__next').disabled, false);
  assert.equal($('.pdf-tools__prev').getAttribute('aria-label'), 'Previous page');
  assert.equal($('.pdf-tools__zoom-in').getAttribute('aria-label'), 'Zoom in');
  assert.equal($('.pdf-tools__fit').textContent, 'Width');
  assert.equal($('.pdf-tools__fit').getAttribute('aria-pressed'), 'true', 'fit width is the start');
  assert.ok($$('#preview-tools button').every((b) => b.type === 'button'));
});

test('paging by button and by the page field, clamped to the document', async (t) => {
  const { host } = await mountPane(t, { pdfs: { '/ws/spec.pdf': pdfBytes() } });
  await host.open(item('spec.pdf'));
  await settle();

  $('.pdf-tools__next').click();
  assert.equal($('.pdf-tools__page').value, '2');
  assert.equal($('.pdf-tools__prev').disabled, false);

  const field = $('.pdf-tools__page');
  field.value = '99';
  press(field, 'Enter');
  assert.equal(field.value, '3', 'past the end means the last page');
  assert.equal($('.pdf-tools__next').disabled, true);

  field.value = 'abc';
  press(field, 'Enter');
  assert.equal(field.value, '3', 'nonsense changes nothing');

  press($('.pdf-view'), 'Home');
  assert.equal(field.value, '1');
  press($('.pdf-view'), 'End');
  assert.equal(field.value, '3');
});

test('zoom steps from the fitted width, and Width returns to it', async (t) => {
  const { host } = await mountPane(t, { pdfs: { '/ws/spec.pdf': pdfBytes() } });
  await host.open(item('spec.pdf'));
  await settle();
  const view = $('.pdf-view');
  Object.defineProperty(view, 'clientWidth', { configurable: true, value: 840 });
  $('.pdf-tools__fit').click();
  await settle();
  // 840 − 2 × 20 padding = 800 px for 595 pt at 96/72 px per pt.
  assert.equal($('.pdf-tools__zoom').textContent, '101 %');
  assert.equal($('.pdf-page').style.width, '800px');

  $('.pdf-tools__zoom-in').click();
  await settle();
  assert.equal($('.pdf-tools__zoom').textContent, '110 %');
  assert.equal($('.pdf-tools__fit').getAttribute('aria-pressed'), 'false');
  assert.equal($('.pdf-page').style.width, '873px');

  $('.pdf-tools__zoom-out').click();
  $('.pdf-tools__zoom-out').click();
  await settle();
  assert.equal($('.pdf-tools__zoom').textContent, '90 %');

  press(view, '=');
  assert.equal($('.pdf-tools__zoom').textContent, '90 %', 'without Cmd/Ctrl a key is just a key');
  view.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }));
  assert.equal($('.pdf-tools__zoom').textContent, '100 %');
  view.dispatchEvent(new KeyboardEvent('keydown', { key: '0', metaKey: true, bubbles: true }));
  assert.equal($('.pdf-tools__zoom').textContent, '101 %');
  assert.equal($('.pdf-tools__fit').getAttribute('aria-pressed'), 'true');
});

test('every reason from the main process becomes a sentence, and the tools go away', async (t) => {
  const cases = [
    [{ ok: false, reason: 'too-large', size: 73 * 1024 * 1024 }, 'Too large to preview', /up to 50\.0\u00a0MB are shown; this file has 73\.0\u00a0MB/],
    [{ ok: false, reason: 'not-pdf' }, 'Not a PDF', /does not start like a PDF/],
    [{ ok: false, reason: 'not-found' }, 'The file cannot be read', /gone/],
    [{ ok: false, reason: 'outside-workspace' }, 'Outside the open folder', /points out of the open folder/],
  ];
  for (const [answer, title, detail] of cases) {
    const { host, calls } = await mountPane(t, { pdfs: { '/ws/x.pdf': answer } });
    await host.open(item('x.pdf'));
    await settle();
    assert.equal(message()?.title, title, answer.reason);
    assert.match(message().detail, detail, answer.reason);
    assert.equal($('.pdf-view__message').getAttribute('role'), 'status');
    assert.equal($('.pdf-view').hidden, true);
    assert.equal($('#preview-tools').hidden, true);
    assert.equal(calls.opened, 0, 'pdf.js is never asked');
    host.dispose();
  }
});

test('a file pdf.js cannot read says so', async (t) => {
  const { host } = await mountPane(t, {
    pdfs: { '/ws/cut.pdf': pdfBytes() },
    open: () => Promise.reject(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' })),
  });
  await host.open(item('cut.pdf'));
  await settle();
  assert.equal(message()?.title, 'Not a readable PDF');
  assert.equal($('#preview-tools').hidden, true);
});

test('a protected PDF asks for its password, says when it is wrong, and opens with the right one', async (t) => {
  const tried = [];
  const { host } = await mountPane(t, {
    pdfs: { '/ws/nda.pdf': pdfBytes() },
    open: (bytes, { onPassword }) => new Promise((resolve) => {
      const ask = (reason) => onPassword((password) => {
        tried.push(password);
        if (password === 'secret') resolve(fakeDocument({ pages: 1 }));
        else queueMicrotask(() => ask('incorrect'));
      }, reason);
      queueMicrotask(() => ask('need'));
    }),
  });
  await host.open(item('nda.pdf'));
  await settle();

  const form = $('.pdf-view__password');
  assert.ok(form, 'the form stands in the column');
  assert.equal($('.pdf-view__message').getAttribute('role'), 'group');
  assert.equal(form.getAttribute('aria-label'), 'Password protected');
  const input = $('.pdf-view__password-input');
  assert.equal(input.type, 'password');
  assert.equal(input.getAttribute('aria-label'), 'Password');
  assert.equal(document.activeElement, input, 'the field has the focus');
  assert.equal($('.pdf-view__password-feedback').textContent, '');

  form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.deepEqual(tried, [], 'an empty field sends nothing');

  input.value = 'wrong';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.deepEqual(tried, ['wrong']);
  assert.equal($('.pdf-view__password-feedback').textContent, 'That password is not right.');
  assert.equal($('.pdf-view__password-input').getAttribute('aria-invalid'), 'true');

  $('.pdf-view__password-input').value = 'secret';
  $('.pdf-view__password').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.deepEqual(tried, ['wrong', 'secret']);
  assert.equal(message(), null);
  assert.equal($('.pdf-view').hidden, false);
  assert.equal($$('.pdf-page').length, 1);
});

test('a refresh with unchanged bytes keeps the document; a change reopens it and lets go of the old one', async (t) => {
  const { host, calls, pdfs } = await mountPane(t, { pdfs: { '/ws/spec.pdf': pdfBytes() } });
  await host.open(item('spec.pdf'));
  await settle();
  $('.pdf-tools__next').click();

  await host.refresh('/ws/spec.pdf');
  await settle();
  assert.equal(calls.pdfs.length, 2, 'read again');
  assert.equal(calls.opened, 1, 'but not reopened');

  pdfs['/ws/spec.pdf'] = pdfBytes({ mtimeMs: 2 });
  await host.refresh('/ws/spec.pdf');
  await settle();
  assert.equal(calls.opened, 2);
  assert.equal(calls.destroyed, 1, 'the old document is destroyed');
  assert.equal($('.pdf-tools__page').value, '2', 'the page is kept');
});

test('leaving the file destroys the document and its worker', async (t) => {
  const { host, calls } = await mountPane(t, { pdfs: { '/ws/spec.pdf': pdfBytes() } });
  await host.open(item('spec.pdf'));
  await settle();
  await host.close();
  assert.equal(calls.destroyed, 1);
});

test('a page that fails to draw says so in its own place', async (t) => {
  const { host } = await mountPane(t, {
    pdfs: { '/ws/spec.pdf': pdfBytes() },
    open: () => Promise.resolve(fakeDocument({ failPage: 2 })),
  });
  await host.open(item('spec.pdf'));
  await settle();
  const pages = $$('.pdf-page');
  assert.ok(pages[0].querySelector('canvas'));
  assert.equal(pages[1].querySelector('.pdf-page__error')?.textContent, 'This page could not be drawn.');
});

test('the view follows the interface language', async (t) => {
  const { host } = await mountPane(t, { pdfs: { '/ws/spec.pdf': pdfBytes() } });
  const { setLocale } = await importRenderer('i18n.js');
  t.after(() => setLocale('en', { force: true }));
  await host.open(item('spec.pdf'));
  await settle();
  setLocale('de', { force: true });
  assert.equal($('.pdf-tools__fit').textContent, 'Breite');
  assert.equal($('.pdf-tools__next').getAttribute('aria-label'), 'Nächste Seite');
  assert.equal($('.pdf-page').getAttribute('aria-label'), 'Seite 1 von 3');
  assert.equal($('#preview-meta').textContent, '13,0 KB · 3 Seiten');
});

test('nextZoom walks the steps from anywhere; fitWidthZoom has no answer without a column', async () => {
  const { nextZoom, fitWidthZoom, ZOOM_STEPS } = await importRenderer('file-views', 'pdf-view.js');
  assert.equal(nextZoom(1, 1), 1.1);
  assert.equal(nextZoom(1.0084, 1), 1.1);
  assert.equal(nextZoom(1.0084, -1), 1);
  assert.equal(nextZoom(ZOOM_STEPS.at(-1), 1), ZOOM_STEPS.at(-1));
  assert.equal(nextZoom(ZOOM_STEPS[0], -1), ZOOM_STEPS[0]);
  assert.equal(Math.round(fitWidthZoom(595, 800) * 1000) / 1000, 1.008);
  assert.equal(fitWidthZoom(595, 0), null);
  assert.equal(fitWidthZoom(0, 800), null);
});
