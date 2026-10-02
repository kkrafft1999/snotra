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
const fs = require('node:fs');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const item = (name, extra = {}) => ({ path: `/ws/${name}`, name, size: 4096, modified: 1, ...extra });
const pdfBytes = (extra = {}) => ({ ok: true, bytes: new Uint8Array([37, 80, 68, 70, 45]), size: 13312, mtimeMs: 1, ...extra });

/** A pdf.js document stand-in: A4 pages that "render" at once. */
function fakeDocument({ pages = 3, failPage = null, unreadablePage = null, sizes = {} } = {}) {
  const renders = [];
  const cleanups = [];
  return {
    numPages: pages,
    renders,
    cleanups,
    async getPage(n) {
      if (n === unreadablePage) throw new Error('Invalid page request.');
      const size = sizes[n] ?? { width: 595, height: 842 };
      return {
        cleanup: () => {
          cleanups.push(n);
          return true;
        },
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

/**
 * A protected PDF whose password nobody enters: pdf.js asks and then waits,
 * as it does — its promise only settles in destroy(), and the stand-in's
 * destroy does not do that, so nothing but the view can end the wait.
 */
const askAndWait = (bytes, { onPassword }) => new Promise(() => {
  queueMicrotask(() => onPassword(() => {}, 'need'));
});

/** Whether a promise settles within a few turns of the event loop. */
async function settlesSoon(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await settle();
  return settled;
}

/** An IntersectionObserver the test drives: happy-dom has none. */
function fakeIntersectionObserver(t) {
  const observers = [];
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe() {}

    disconnect() {
      this.callback = null;
    }
  };
  t.after(() => { delete globalThis.IntersectionObserver; });
  return {
    report(entries) {
      observers.findLast((o) => o.callback)?.callback(entries.map(([n, isIntersecting]) => ({
        target: $(`.pdf-page[data-page="${n}"]`),
        isIntersecting,
      })));
    },
  };
}

/** A ResizeObserver the test drives, for the fit-width re-layout. */
function fakeResizeObserver() {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe() {}

    disconnect() {}
  };
  return { resize: () => observers.forEach((o) => o.callback([])) };
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
  assert.equal(document.activeElement, $('.pdf-view__password-input'), 'after the own wrong try the field has the focus again');

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

test('leaving a protected PDF at the password prompt destroys the load that waits for it, once', async (t) => {
  const { host, calls } = await mountPane(t, { pdfs: { '/ws/nda.pdf': pdfBytes() }, open: askAndWait });
  await host.open(item('nda.pdf'));
  await settle();
  assert.ok($('.pdf-view__password'));
  assert.equal(calls.destroyed, 0);

  await host.close();
  assert.equal(calls.destroyed, 1, 'the pending load and its worker are let go of');
  host.dispose();
  assert.equal(calls.destroyed, 1, 'and only once');
});

test('a refresh at the password prompt with unchanged bytes opens nothing; what is typed and the focus stay', async (t) => {
  const { host, calls } = await mountPane(t, { pdfs: { '/ws/nda.pdf': pdfBytes() }, open: askAndWait });
  await host.open(item('nda.pdf'));
  await settle();
  const input = $('.pdf-view__password-input');
  input.value = 'half-typ';
  // The user has moved on to the chat composer meanwhile.
  const composer = document.getElementById('chat-input');
  composer.focus();

  assert.equal(await settlesSoon(host.refresh('/ws/nda.pdf')), true, 'the refresh does not wait for the password');
  assert.equal(calls.pdfs.length, 2, 'read again');
  assert.equal(calls.opened, 1, 'but not reopened');
  assert.equal($('.pdf-view__password-input'), input, 'the form is not rebuilt');
  assert.equal(input.value, 'half-typ');
  assert.equal(document.activeElement, composer, 'the focus stays where the user is');
});

test('new bytes at the password prompt reopen without waiting for the user, and without taking the focus', async (t) => {
  const { host, calls, pdfs } = await mountPane(t, { pdfs: { '/ws/nda.pdf': pdfBytes() }, open: askAndWait });
  await host.open(item('nda.pdf'));
  await settle();
  $('.pdf-view__password-input').value = 'half';
  const composer = document.getElementById('chat-input');
  composer.focus();

  pdfs['/ws/nda.pdf'] = pdfBytes({ mtimeMs: 2 });
  assert.equal(await settlesSoon(host.refresh('/ws/nda.pdf')), true, 'the tree does not wait at the prompt');
  assert.equal(calls.opened, 2);
  assert.equal(calls.destroyed, 1, 'the load it supersedes is destroyed');
  assert.equal($('.pdf-view__password-input').value, 'half', 'what is typed is kept');
  assert.equal(document.activeElement, composer);
});

test('a language switch at the password prompt keeps what is typed, and the focus where it is', async (t) => {
  const { host } = await mountPane(t, { pdfs: { '/ws/nda.pdf': pdfBytes() }, open: askAndWait });
  const { setLocale } = await importRenderer('i18n.js');
  t.after(() => setLocale('en', { force: true }));
  await host.open(item('nda.pdf'));
  await settle();
  $('.pdf-view__password-input').value = 'half';
  const composer = document.getElementById('chat-input');
  composer.focus();

  setLocale('de', { force: true });
  assert.equal($('.pdf-view__password-submit').textContent, 'Öffnen');
  assert.equal($('.pdf-view__password-input').value, 'half');
  assert.equal(document.activeElement, composer);

  $('.pdf-view__password-input').focus();
  setLocale('en', { force: true });
  assert.equal(document.activeElement, $('.pdf-view__password-input'), 'a focus in the form stays in it');
});

test('host.refresh() settles once the view is left, whatever pdf.js does', async (t) => {
  let opens = 0;
  const { host, calls, pdfs } = await mountPane(t, {
    pdfs: { '/ws/nda.pdf': pdfBytes() },
    // First the prompt; then, for the changed file, a pdf.js that neither
    // asks nor answers.
    open: (bytes, options) => {
      opens += 1;
      return opens === 1 ? askAndWait(bytes, options) : new Promise(() => {});
    },
  });
  await host.open(item('nda.pdf'));
  await settle();

  pdfs['/ws/nda.pdf'] = pdfBytes({ mtimeMs: 2 });
  const refreshing = host.refresh('/ws/nda.pdf');
  assert.equal(await settlesSoon(refreshing), false, 'still opening');
  await host.close();
  assert.equal(await settlesSoon(refreshing), true, 'the tree chain goes on');
  assert.equal(calls.destroyed, 2, 'both loads are let go of');
});

test('a page lets go of what pdf.js decoded when it leaves the render window, and on a zoom', async (t) => {
  const pdf = fakeDocument({ pages: 5 });
  const { host } = await mountPane(t, { pdfs: { '/ws/spec.pdf': pdfBytes() }, open: () => Promise.resolve(pdf) });
  const viewport = fakeIntersectionObserver(t);
  await host.open(item('spec.pdf'));
  await settle();
  viewport.report([[1, true], [2, true], [3, true]]);
  await settle();
  assert.deepEqual($$('.pdf-page canvas').map((c) => c.closest('.pdf-page').dataset.page), ['1', '2', '3']);

  viewport.report([[1, false]]);
  assert.deepEqual(pdf.cleanups, [1], 'released with its canvas');
  assert.equal($('.pdf-page[data-page="1"] canvas'), null);

  $('.pdf-tools__zoom-in').click();
  assert.deepEqual(pdf.cleanups.sort(), [1, 2, 3], 'a re-layout releases every drawn page');
});

test('a document whose first page cannot be read is let go of, and the header stays with the reason', async (t) => {
  const { host, calls } = await mountPane(t, {
    pdfs: { '/ws/cut.pdf': pdfBytes() },
    open: () => Promise.resolve(fakeDocument({ unreadablePage: 1 })),
  });
  const { setLocale } = await importRenderer('i18n.js');
  t.after(() => setLocale('en', { force: true }));
  await host.open(item('cut.pdf'));
  await settle();
  assert.equal(message()?.title, 'Not a readable PDF');
  assert.equal(calls.destroyed, 1, 'document and worker are destroyed');
  assert.equal($('#preview-meta').textContent, '13.0 KB');

  setLocale('de', { force: true });
  assert.equal(message()?.title, 'Keine lesbare PDF');
  assert.equal($('#preview-meta').textContent, '13,0 KB', 'no page count next to the reason');
});

test('a broken PDF is not opened again while its bytes stay the same', async (t) => {
  const cases = {
    'pdf.js rejects the file': () => Promise.reject(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' })),
    'page 1 cannot be read': () => Promise.resolve(fakeDocument({ unreadablePage: 1 })),
  };
  for (const [what, open] of Object.entries(cases)) {
    const { host, calls, pdfs } = await mountPane(t, { pdfs: { '/ws/cut.pdf': pdfBytes() }, open });
    await host.open(item('cut.pdf'));
    await settle();
    assert.equal(message()?.title, 'Not a readable PDF', what);

    await host.refresh('/ws/cut.pdf');
    await settle();
    assert.equal(calls.pdfs.length, 2, `${what}: read again`);
    assert.equal(calls.opened, 1, `${what}: but no new worker for the same bytes`);
    assert.equal(message()?.title, 'Not a readable PDF', what);

    pdfs['/ws/cut.pdf'] = pdfBytes({ mtimeMs: 2 });
    await host.refresh('/ws/cut.pdf');
    await settle();
    assert.equal(calls.opened, 2, `${what}: changed bytes are tried`);
    host.dispose();
  }
});

test('the zoom is said when the user zooms, not when the column width moves it', async (t) => {
  const { host } = await mountPane(t, { pdfs: { '/ws/spec.pdf': pdfBytes() } });
  const column = fakeResizeObserver();
  await host.open(item('spec.pdf'));
  await settle();
  const announcer = $('.pdf-view__announcer');
  assert.equal(announcer.getAttribute('role'), 'status');
  assert.equal($('.pdf-tools__zoom').getAttribute('aria-live'), 'off', 'the visible value is not a live region');

  const view = $('.pdf-view');
  Object.defineProperty(view, 'clientWidth', { configurable: true, value: 840 });
  column.resize();
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal($('.pdf-tools__zoom').textContent, '101 %', 'Width follows the column');
  assert.equal(announcer.textContent, '', 'and says nothing');

  $('.pdf-tools__zoom-in').click();
  assert.equal(announcer.textContent, '110 %');
  view.dispatchEvent(new KeyboardEvent('keydown', { key: '0', metaKey: true, bubbles: true }));
  assert.equal(announcer.textContent, '101 %');
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

test('the PDF view keeps to the tokens: ink for the paper, no amber, 32 px touch targets (#641)', () => {
  const read = (file) => fs.readFileSync(path.join(RENDERER_DIR, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const styles = read('styles.css');
  const tokens = read(path.join('styles', 'tokens.css'));
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = styles.match(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(found, `${selector} is in styles.css`);
    return found[1];
  };
  const dark = tokens.match(/\[data-theme='dark'\]\s*\{([^}]*)\}/)[1];

  // The page is white in both themes, and so must its ink be.
  assert.match(rule('.pdf-page__error'), /color:\s*var\(--ds-paper-ink\)/);
  assert.match(tokens, /--ds-paper-ink:\s*#[0-9A-Fa-f]{6};/);
  assert.doesNotMatch(dark, /--ds-paper(?:-ink)?:/, 'paper and ink do not follow the theme');

  for (const selector of ['.pdf-view__password-feedback', ".pdf-view__password-input[aria-invalid='true']"]) {
    assert.doesNotMatch(rule(selector), /--ds-warning/, `${selector}: amber means "not isolated" only`);
    assert.match(rule(selector), /var\(--ds-error\)/, selector);
  }

  assert.match(rule('.pdf-tools__button'), /min-width:\s*var\(--ds-touch-min\);/);
  assert.match(rule('.pdf-tools__button'), /\bheight:\s*var\(--ds-touch-min\);/);
  assert.match(rule('.pdf-tools__page'), /\bheight:\s*var\(--ds-touch-min\);/);
  assert.match(rule('.ds-segmented__option'), /min-height:\s*var\(--ds-touch-min\);/);
  assert.doesNotMatch(rule('.ds-segmented--compact .ds-segmented__option'), /height/,
    'the header\'s "Preview | Source" keeps the 32 px');
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
