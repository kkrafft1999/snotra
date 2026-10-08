// PDFs in the file preview (#346), drawn by the vendored pdf.js.
//
// The bytes come through `fs:readWorkspacePdf`: the main process checks the
// path lexically and via `realpath`, decides the type by the content and holds
// the 50 MB limit, as it does for images (#244, #345). The view declares
// `reads: 'none'`, the host leaves the file alone. How pdf.js is loaded, and
// what of it is switched off, is in `pdf-engine.js`.
//
// Decided with a mockup on 2026-09-27: continuous scrolling, page number and
// zoom in the header, pages white like paper in both themes, and a password
// field in the column for a protected PDF.
//
// **Only what is near the viewport is drawn.** Every page has a placeholder
// from the start, sized like page 1 — asking pdf.js for the size of every
// page up front would load each one, thousands in a long scan (#634). So the
// scroll bar is right for 300 pages of one size; a page of another size takes
// its own once it comes near the viewport. An IntersectionObserver draws a
// page when it comes within one screen of the viewport and, when it moves
// further away, lets go of its canvas and of what pdf.js decoded for it
// (`page.cleanup()` — for the screen pdf.js only does that by itself after
// printing). A 300-page manual therefore costs a handful of pages, not three
// hundred.
//
// The interface it implements is documented in the header of `registry.js`.

import contracts from '../generated/contracts.js';
import { t, tPlural, onLocaleChange } from '../i18n.js';
import { formatSize } from '../utils/helpers.js';
import { openPdfDocument } from './pdf-engine.js';
import { ZOOM_STEPS, nextZoom, iconButton, ZOOM_IN_ICON, ZOOM_OUT_ICON } from './zoom-tools.js';

export { ZOOM_STEPS, nextZoom };

const { MAX_WORKSPACE_PDF_BYTES, WORKSPACE_PDF_ERRORS } = contracts;

// 100 % means one PDF point as 1/72 inch on a 96 dpi screen, as in every
// other PDF viewer.
const CSS_PX_PER_PT = 96 / 72;
// Must match the padding of `.pdf-view__pages` in styles.css.
const PAGES_PADDING_PX = 20;
// Above this a canvas is drawn at a lower resolution rather than not at all
// — Chromium refuses canvases of more than about 268 million pixels, and
// memory gives out long before.
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const LOADING_DELAY_MS = 200;
// How far outside the viewport a page is still drawn: one screen above and
// below, so that scrolling finds the next page ready.
const RENDER_MARGIN = '100% 0px';

const ERROR_KEYS = Object.freeze({
  [WORKSPACE_PDF_ERRORS.NO_WORKSPACE]: 'noWorkspace',
  [WORKSPACE_PDF_ERRORS.OUTSIDE_WORKSPACE]: 'outsideWorkspace',
  [WORKSPACE_PDF_ERRORS.NOT_FOUND]: 'notFound',
  [WORKSPACE_PDF_ERRORS.TOO_LARGE]: 'tooLarge',
  [WORKSPACE_PDF_ERRORS.NOT_PDF]: 'notPdf',
  broken: 'broken',
});

/**
 * The zoom at which a page of `pageWidthPt` fills `availablePx`. Null while
 * the column has no width yet.
 */
export function fitWidthZoom(pageWidthPt, availablePx) {
  if (!(pageWidthPt > 0) || !(availablePx > 0)) return null;
  return availablePx / (pageWidthPt * CSS_PX_PER_PT);
}

function nbsp(text) {
  return text.replace(' ', ' ');
}

/**
 * Builds the view. `openDocument(api, bytes, { onPassword })` is pdf.js in
 * the app and a stand-in in the tests, which have no canvas and no worker.
 */
export function createPdfView({ openDocument = openPdfDocument } = {}) {
  return {
    id: 'pdf',
    kind: 'viewer',
    reads: 'none',

    canHandle({ ext }) {
      return ext === 'pdf';
    },

    mount(hostEl, context) {
      const { api, file } = context;
      let disposed = false;
      let loadingTimer = null;
      // Every open draws a number; a read that returns for an older one is
      // dropped. Which load may show its document decides `pending` below.
      let openGeneration = 0;
      let loaded = null; // { size, mtimeMs } of what is on show
      let handle = null; // { promise, destroy } from openDocument
      // The open still under way: { size, mtimeMs, handle, stop, stopped,
      // ask, asked }. Kept so that leaving the view or a newer open can
      // destroy it — a load waiting at the password prompt never settles on
      // its own, pdf.js only rejects it in destroy() (#634).
      let pending = null;
      let doc = null;
      let pageCount = 0;
      let defaultSize = null; // { width, height } in PDF points
      const pageSizes = new Map();
      // Zoom: 'fit' follows the column width; otherwise a fixed factor.
      let zoomMode = 'fit';
      let zoom = 1;
      let currentPage = 1;
      // Pages with a canvas, and the render still running for each.
      const rendering = new Map();
      let layoutGeneration = 0;
      // Remembered for this mount only, so that a change on disk does not
      // ask again. Never stored, never sent anywhere.
      let password = null;
      let passwordAnswer = null;
      // The field takes the focus when the form first appears and after the
      // user's own wrong password — never when a change on disk redraws it
      // while the user is somewhere else (#634).
      let passwordAsked = false;
      let passwordSubmitted = false;
      let observer = null;
      let scrollFrame = 0;
      let resizeTimer = null;

      const viewEl = document.createElement('div');
      viewEl.className = 'pdf-view';
      viewEl.tabIndex = 0;
      viewEl.setAttribute('role', 'document');
      viewEl.setAttribute('aria-label', file.name);
      viewEl.hidden = true;
      const pagesEl = document.createElement('div');
      pagesEl.className = 'pdf-view__pages';
      viewEl.append(pagesEl);

      const messageEl = document.createElement('div');
      messageEl.className = 'pdf-view__message';
      messageEl.hidden = true;

      // Says the zoom after the user changed it — and only then (#641).
      const announcerEl = document.createElement('p');
      announcerEl.className = 'sr-only pdf-view__announcer';
      announcerEl.setAttribute('role', 'status');

      hostEl.append(viewEl, messageEl, announcerEl);

      // ── Header tools: page and zoom ─────────────────────────────────────

      const pagerEl = document.createElement('div');
      pagerEl.className = 'pdf-tools';
      pagerEl.setAttribute('role', 'group');
      const prevButton = iconButton('pdf-tools__prev', 'M10 3.5 5.5 8l4.5 4.5');
      const pageInput = document.createElement('input');
      pageInput.className = 'pdf-tools__page';
      pageInput.type = 'text';
      pageInput.inputMode = 'numeric';
      pageInput.autocomplete = 'off';
      const pageTotal = document.createElement('span');
      pageTotal.className = 'pdf-tools__total';
      const nextButton = iconButton('pdf-tools__next', 'M6 3.5 10.5 8 6 12.5');
      pagerEl.append(prevButton, pageInput, pageTotal, nextButton);

      const zoomEl = document.createElement('div');
      zoomEl.className = 'pdf-tools';
      zoomEl.setAttribute('role', 'group');
      const zoomOutButton = iconButton('pdf-tools__zoom-out', ZOOM_OUT_ICON);
      const zoomValue = document.createElement('output');
      zoomValue.className = 'pdf-tools__zoom';
      // Not live: "Width" redraws on every step of a divider drag or a window
      // resize, and each new percentage would be read out (#641). What the
      // user zoomed to is said once, through the announcer below.
      zoomValue.setAttribute('aria-live', 'off');
      const zoomInButton = iconButton('pdf-tools__zoom-in', ZOOM_IN_ICON);
      const fitButton = document.createElement('button');
      fitButton.type = 'button';
      fitButton.className = 'pdf-tools__button pdf-tools__fit';
      zoomEl.append(zoomOutButton, zoomValue, zoomInButton, fitButton);

      function applyToolLabels() {
        pagerEl.setAttribute('aria-label', t('fileView.pdf.pager.label'));
        prevButton.setAttribute('aria-label', t('fileView.pdf.pager.previous'));
        prevButton.title = prevButton.getAttribute('aria-label');
        nextButton.setAttribute('aria-label', t('fileView.pdf.pager.next'));
        nextButton.title = nextButton.getAttribute('aria-label');
        pageInput.setAttribute('aria-label', t('fileView.pdf.pager.input', { count: pageCount }));
        zoomEl.setAttribute('aria-label', t('fileView.pdf.zoom.label'));
        zoomOutButton.setAttribute('aria-label', t('fileView.pdf.zoom.out'));
        zoomOutButton.title = zoomOutButton.getAttribute('aria-label');
        zoomInButton.setAttribute('aria-label', t('fileView.pdf.zoom.in'));
        zoomInButton.title = zoomInButton.getAttribute('aria-label');
        fitButton.textContent = t('fileView.pdf.zoom.fit');
        fitButton.title = t('fileView.pdf.zoom.fitTitle');
      }

      function renderTools() {
        pageTotal.textContent = `/ ${pageCount}`;
        if (document.activeElement !== pageInput) pageInput.value = String(currentPage);
        prevButton.disabled = currentPage <= 1;
        nextButton.disabled = currentPage >= pageCount;
        zoomValue.textContent = `${Math.round(zoom * 100)} %`;
        zoomOutButton.disabled = zoom <= ZOOM_STEPS[0] + 0.001;
        zoomInButton.disabled = zoom >= ZOOM_STEPS.at(-1) - 0.001;
        fitButton.setAttribute('aria-pressed', String(zoomMode === 'fit'));
      }

      function showTools(visible) {
        context.setTools(visible ? [pagerEl, zoomEl] : null);
      }

      prevButton.addEventListener('click', () => goToPage(currentPage - 1));
      nextButton.addEventListener('click', () => goToPage(currentPage + 1));
      pageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitPageInput();
        } else if (event.key === 'Escape') {
          pageInput.value = String(currentPage);
          pageInput.select();
        }
      });
      pageInput.addEventListener('change', commitPageInput);
      pageInput.addEventListener('focus', () => pageInput.select());
      pageInput.addEventListener('blur', () => {
        pageInput.value = String(currentPage);
      });
      zoomOutButton.addEventListener('click', () => setZoom(nextZoom(zoom, -1)));
      zoomInButton.addEventListener('click', () => setZoom(nextZoom(zoom, 1)));
      fitButton.addEventListener('click', () => setZoom('fit'));

      function commitPageInput() {
        const wanted = Number.parseInt(pageInput.value, 10);
        if (Number.isFinite(wanted)) goToPage(wanted);
        pageInput.value = String(currentPage);
      }

      // ── Messages: loading, errors, password ─────────────────────────────

      function showMessage(nodes, { role = 'status' } = {}) {
        viewEl.hidden = true;
        showTools(false);
        messageEl.setAttribute('role', role);
        messageEl.replaceChildren(...nodes);
        messageEl.hidden = false;
      }

      function messageText(title, detail) {
        const titleEl = document.createElement('strong');
        titleEl.className = 'pdf-view__message-title';
        titleEl.textContent = title;
        const nodes = [titleEl];
        if (detail) {
          const detailEl = document.createElement('span');
          detailEl.className = 'pdf-view__message-detail';
          detailEl.textContent = detail;
          nodes.push(detailEl);
        }
        return nodes;
      }

      // `mtimeMs` only for 'broken': the bytes pdf.js failed on, so that a
      // refresh does not start another worker for them.
      let shownError = null;
      function showError(reason, size, mtimeMs = null) {
        clearTimeout(loadingTimer);
        shownError = { reason, size, mtimeMs };
        const key = ERROR_KEYS[reason] ?? ERROR_KEYS[WORKSPACE_PDF_ERRORS.NOT_FOUND];
        showMessage(messageText(
          t(`fileView.pdf.error.${key}.title`),
          t(`fileView.pdf.error.${key}.detail`, {
            limit: nbsp(formatSize(MAX_WORKSPACE_PDF_BYTES)),
            size: nbsp(formatSize(size ?? file.size)),
          }),
        ));
        context.setMeta({ size: size ?? file.size, detail: null });
      }

      function showLoading() {
        clearTimeout(loadingTimer);
        loadingTimer = setTimeout(() => {
          if (!disposed && !doc && !shownError && !passwordAnswer) {
            showMessage(messageText(t('fileView.pdf.loading')));
          }
        }, LOADING_DELAY_MS);
      }

      let passwordState = null; // null, 'need', 'incorrect', 'checking'
      function showPasswordForm(state) {
        clearTimeout(loadingTimer);
        passwordState = state;
        // A redraw — another language, the file changed on disk — keeps what
        // is typed, and the focus only if it was in the form (#634). What the
        // user just sent goes: it is the answer pdf.js turned down.
        const previous = messageEl.querySelector('.pdf-view__password-input');
        const typed = passwordSubmitted ? '' : previous?.value ?? '';
        const takeFocus = !passwordAsked || passwordSubmitted
          || Boolean(previous && messageEl.contains(document.activeElement));
        passwordAsked = true;
        passwordSubmitted = false;
        const form = document.createElement('form');
        form.className = 'pdf-view__password';
        form.noValidate = true;
        const nodes = messageText(t('fileView.pdf.password.title'), t('fileView.pdf.password.detail'));
        const row = document.createElement('div');
        row.className = 'pdf-view__password-row';
        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'modal-input pdf-view__password-input';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', t('fileView.pdf.password.field'));
        input.placeholder = t('fileView.pdf.password.field');
        input.value = typed;
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'btn-primary pdf-view__password-submit';
        submit.textContent = t('fileView.pdf.password.submit');
        row.append(input, submit);
        const feedback = document.createElement('span');
        feedback.className = 'pdf-view__password-feedback';
        feedback.setAttribute('role', 'alert');
        if (state === 'incorrect') {
          feedback.textContent = t('fileView.pdf.password.wrong');
          input.setAttribute('aria-invalid', 'true');
        }
        form.append(...nodes, row, feedback);
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!passwordAnswer || !input.value) {
            input.focus();
            return;
          }
          const answer = passwordAnswer;
          passwordAnswer = null;
          password = input.value;
          passwordState = 'checking';
          passwordSubmitted = true;
          submit.disabled = true;
          input.disabled = true;
          answer(password);
        });
        // The form is the whole message; the title is read with it.
        showMessage([form], { role: 'group' });
        form.setAttribute('aria-label', t('fileView.pdf.password.title'));
        if (takeFocus) input.focus();
      }

      function onPassword(load, answer, reason) {
        // A load that was stopped may still ask; nobody is there to answer.
        if (disposed || pending !== load) return;
        // After a change on disk the remembered password is tried once.
        if (reason === 'need' && password && passwordState !== 'need') {
          passwordState = 'checking';
          answer(password);
          return;
        }
        passwordAnswer = answer;
        showPasswordForm(reason);
        // From here on the load waits for the user, and whoever asked for it
        // — the tree's refresh — must not (#634).
        load.ask();
      }

      // ── Opening ─────────────────────────────────────────────────────────

      const sameBytes = (a, b) => Boolean(a && b && a.mtimeMs === b.mtimeMs && a.size === b.size);

      /**
       * Reads the file and shows it. Settles once the view has done what it
       * can on its own: the document or a reason is on show, the password
       * form waits for the user, or the load was stopped because the view
       * went away or a newer open took over — whatever pdf.js does (#634).
       */
      async function open() {
        const generation = ++openGeneration;
        if (!doc && !pending) showLoading();
        let result = null;
        try {
          result = await api.readWorkspacePdf(file.path);
        } catch {
          result = null;
        }
        if (disposed || generation !== openGeneration) return;
        if (!result?.ok) {
          stopPending();
          closeDocument();
          showError(result?.reason ?? WORKSPACE_PDF_ERRORS.NOT_FOUND, result?.size);
          return;
        }
        if (pending) {
          // These very bytes are still opening — at the password prompt, say.
          // A second load would redraw the form, wipe what is typed and take
          // the focus from wherever the user is (#634).
          if (sameBytes(pending, result)) return;
          stopPending();
        } else if (doc && sameBytes(loaded, result)) {
          // Unchanged on disk: keep the document, the zoom and the place.
          return;
        } else if (shownError?.reason === 'broken' && sameBytes(shownError, result)) {
          // The bytes pdf.js could not read are still the same: they would
          // fail again, in a fresh worker, on every report from the watcher.
          return;
        }

        const load = { size: result.size, mtimeMs: result.mtimeMs, handle: null };
        load.stopped = new Promise((resolve) => { load.stop = resolve; });
        load.asked = new Promise((resolve) => { load.ask = resolve; });
        pending = load;
        await Promise.race([loadDocument(load, result.bytes), load.stopped, load.asked]);
      }

      async function loadDocument(load, bytes) {
        const current = () => !disposed && pending === load;
        let next;
        try {
          load.handle = await openDocument(api, bytes, {
            onPassword: (answer, reason) => onPassword(load, answer, reason),
          });
          if (!current()) {
            letGo(load.handle);
            return;
          }
          // Raced against the stop: pdf.js's promise may never settle.
          next = await Promise.race([load.handle.promise, load.stopped]);
        } catch (err) {
          if (!current()) return;
          pending = null;
          letGo(load.handle);
          closeDocument();
          showError('broken', load.size, load.mtimeMs);
          if (err?.name !== 'InvalidPDFException') console.warn('PDF could not be opened:', err?.message ?? err);
          return;
        }
        // Stopped: stopPending() has let go of the handle already.
        if (!current()) return;
        pending = null;
        const keepPage = doc ? currentPage : 1;
        closeDocument();
        handle = load.handle;
        doc = next;
        loaded = { size: load.size, mtimeMs: load.mtimeMs };
        passwordState = null;
        shownError = null;
        await showDocument(keepPage);
      }

      /** Destroys the open under way, wherever it stands, and settles it. */
      function stopPending() {
        const load = pending;
        if (!load) return;
        pending = null;
        // The question belonged to that load.
        passwordAnswer = null;
        letGo(load.handle);
        load.stop();
      }

      function letGo(target) {
        if (!target) return;
        try {
          // pdf.js destroys asynchronously; a failure there leaves nothing to do.
          Promise.resolve(target.destroy()).catch(() => {});
        } catch {
          // Nothing left to let go of.
        }
      }

      function closeDocument() {
        cancelAllRenders();
        observer?.disconnect();
        pagesEl.replaceChildren();
        pageSizes.clear();
        letGo(handle);
        handle = null;
        doc = null;
        loaded = null;
      }

      async function showDocument(startPage) {
        clearTimeout(loadingTimer);
        const shownDoc = doc;
        pageCount = doc.numPages;
        let first;
        try {
          first = await doc.getPage(1);
        } catch {
          if (disposed || doc !== shownDoc) return;
          // Nothing of it can be shown: let go of document and worker, and
          // keep the header to the reason (#641).
          const { size, mtimeMs } = loaded ?? {};
          closeDocument();
          pageCount = 0;
          showError('broken', size, mtimeMs);
          return;
        }
        if (disposed || doc !== shownDoc) return;
        const viewport = first.getViewport({ scale: 1 });
        defaultSize = { width: viewport.width, height: viewport.height };
        pageSizes.set(1, defaultSize);

        const placeholders = [];
        for (let n = 1; n <= pageCount; n += 1) {
          const pageEl = document.createElement('div');
          pageEl.className = 'pdf-page';
          pageEl.dataset.page = String(n);
          pageEl.setAttribute('role', 'img');
          placeholders.push(pageEl);
        }
        pagesEl.replaceChildren(...placeholders);
        applyPageLabels();
        messageEl.hidden = true;
        viewEl.hidden = false;
        showTools(true);
        applyToolLabels();
        context.setMeta({ size: loaded.size, detail: tPlural('fileView.pdf.pages', pageCount, { count: pageCount }) });
        currentPage = Math.min(Math.max(1, startPage), pageCount);
        layout({ keepPage: currentPage, fraction: 0 });
      }

      function applyPageLabels() {
        for (const pageEl of pagesEl.children) {
          pageEl.setAttribute('aria-label', t('fileView.pdf.page.label', { page: pageEl.dataset.page, count: pageCount }));
        }
      }

      // ── Layout and drawing ──────────────────────────────────────────────

      function effectiveZoom() {
        if (zoomMode !== 'fit') return zoom;
        const available = viewEl.clientWidth - 2 * PAGES_PADDING_PX;
        return fitWidthZoom(defaultSize?.width, available) ?? zoom;
      }

      function sizeOf(n) {
        return pageSizes.get(n) ?? defaultSize;
      }

      function placePage(pageEl) {
        const size = sizeOf(Number(pageEl.dataset.page));
        pageEl.style.width = `${Math.round(size.width * CSS_PX_PER_PT * zoom)}px`;
        pageEl.style.height = `${Math.round(size.height * CSS_PX_PER_PT * zoom)}px`;
      }

      /**
       * Sizes every placeholder for the current zoom and redraws what is in
       * view. `keepPage`/`fraction` put the same spot of the same page back at
       * the top of the column, so that zooming does not lose the place.
       */
      function layout({ keepPage = currentPage, fraction = null } = {}) {
        if (!doc || !defaultSize) return;
        const anchor = fraction ?? currentFraction(keepPage);
        zoom = effectiveZoom();
        layoutGeneration += 1;
        cancelAllRenders();
        for (const pageEl of pagesEl.children) placePage(pageEl);
        const target = pagesEl.children[keepPage - 1];
        if (target) viewEl.scrollTop = target.offsetTop + anchor * target.offsetHeight - PAGES_PADDING_PX;
        currentPage = keepPage;
        renderTools();
        observePages();
      }

      function currentFraction(n) {
        const pageEl = pagesEl.children[n - 1];
        if (!pageEl || !pageEl.offsetHeight) return 0;
        const top = viewEl.scrollTop + PAGES_PADDING_PX - pageEl.offsetTop;
        return Math.min(Math.max(top / pageEl.offsetHeight, 0), 1);
      }

      function observePages() {
        observer?.disconnect();
        if (typeof IntersectionObserver !== 'function') {
          // No layout engine (tests): draw the first pages, as a real
          // viewport would show them.
          for (let n = 1; n <= Math.min(pageCount, 2); n += 1) void renderPage(n);
          return;
        }
        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const n = Number(entry.target.dataset.page);
            if (entry.isIntersecting) void renderPage(n);
            else releasePage(n);
          }
        }, { root: viewEl, rootMargin: RENDER_MARGIN });
        for (const pageEl of pagesEl.children) observer.observe(pageEl);
      }

      async function renderPage(n) {
        if (!doc || rendering.has(n)) return;
        const generation = layoutGeneration;
        const pageEl = pagesEl.children[n - 1];
        if (!pageEl) return;
        const entry = { task: null, page: null };
        rendering.set(n, entry);
        try {
          const page = await doc.getPage(n);
          if (disposed || generation !== layoutGeneration || rendering.get(n) !== entry) return;
          entry.page = page;
          const base = page.getViewport({ scale: 1 });
          if (!pageSizes.has(n)) {
            pageSizes.set(n, { width: base.width, height: base.height });
            if (base.width !== defaultSize.width || base.height !== defaultSize.height) placePage(pageEl);
          }
          const cssScale = zoom * CSS_PX_PER_PT;
          let pixelRatio = globalThis.devicePixelRatio || 1;
          const cssPixels = base.width * base.height * cssScale * cssScale;
          if (cssPixels * pixelRatio * pixelRatio > MAX_CANVAS_PIXELS) {
            pixelRatio = Math.sqrt(MAX_CANVAS_PIXELS / cssPixels);
          }
          const viewport = page.getViewport({ scale: cssScale * pixelRatio });
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page__canvas';
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          canvas.setAttribute('aria-hidden', 'true');
          entry.task = page.render({ canvas, viewport });
          await entry.task.promise;
          if (disposed || generation !== layoutGeneration || rendering.get(n) !== entry) return;
          pageEl.replaceChildren(canvas);
          pageEl.classList.remove('pdf-page--failed');
        } catch (err) {
          if (err?.name === 'RenderingCancelledException') return;
          if (disposed || generation !== layoutGeneration || rendering.get(n) !== entry) return;
          const note = document.createElement('span');
          note.className = 'pdf-page__error';
          note.textContent = t('fileView.pdf.page.error');
          pageEl.replaceChildren(note);
          pageEl.classList.add('pdf-page--failed');
        }
      }

      function releasePage(n) {
        const entry = rendering.get(n);
        if (!entry) return;
        rendering.delete(n);
        try {
          entry.task?.cancel();
        } catch {
          // Already done.
        }
        // The decoded images and the operator list stay in the renderer
        // otherwise — 7–9 MB a page for a scan (#634). pdf.js frees them
        // once the cancelled render has wound down; a page drawn again
        // fetches them anew.
        try {
          entry.page?.cleanup();
        } catch {
          // The document is gone already.
        }
        const pageEl = pagesEl.children[n - 1];
        if (pageEl && !pageEl.classList.contains('pdf-page--failed')) pageEl.replaceChildren();
      }

      function cancelAllRenders() {
        for (const n of [...rendering.keys()]) releasePage(n);
        // A page drawn at the old zoom would be blurry or clipped; the next
        // pass draws it again.
        for (const pageEl of pagesEl.children) pageEl.replaceChildren();
      }

      function setZoom(next) {
        if (!doc) return;
        const keepPage = currentPage;
        const fraction = currentFraction(keepPage);
        if (next === 'fit') {
          zoomMode = 'fit';
        } else {
          zoomMode = 'fixed';
          zoom = next;
        }
        layout({ keepPage, fraction });
        // Only here, where the user zoomed: a re-layout for the column width
        // stays silent (#641).
        announcerEl.textContent = zoomValue.textContent;
      }

      function goToPage(n) {
        if (!doc) return;
        const target = Math.min(Math.max(1, n), pageCount);
        const pageEl = pagesEl.children[target - 1];
        if (pageEl) viewEl.scrollTop = pageEl.offsetTop - PAGES_PADDING_PX;
        currentPage = target;
        renderTools();
      }

      function updateCurrentPage() {
        scrollFrame = 0;
        if (!doc) return;
        // The page that holds the line a third down the column.
        const line = viewEl.scrollTop + viewEl.clientHeight / 3;
        let found = 1;
        for (const pageEl of pagesEl.children) {
          if (pageEl.offsetTop <= line) found = Number(pageEl.dataset.page);
          else break;
        }
        if (found !== currentPage) {
          currentPage = found;
          renderTools();
        }
      }

      function onScroll() {
        if (!scrollFrame) scrollFrame = requestAnimationFrame(updateCurrentPage);
      }

      function onKeyDown(event) {
        if (event.target !== viewEl || event.altKey) return;
        const mod = event.metaKey || event.ctrlKey;
        if (mod && (event.key === '+' || event.key === '=')) {
          event.preventDefault();
          setZoom(nextZoom(zoom, 1));
        } else if (mod && event.key === '-') {
          event.preventDefault();
          setZoom(nextZoom(zoom, -1));
        } else if (mod && event.key === '0') {
          event.preventDefault();
          setZoom('fit');
        } else if (!mod && (event.key === 'Home' || event.key === 'End')) {
          event.preventDefault();
          goToPage(event.key === 'Home' ? 1 : pageCount);
        }
      }

      viewEl.addEventListener('scroll', onScroll, { passive: true });
      viewEl.addEventListener('keydown', onKeyDown);

      // Fit width follows the column; debounced, since a drag on the divider
      // reports every pixel.
      let lastWidth = 0;
      const resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
          const width = viewEl.clientWidth;
          if (zoomMode !== 'fit' || !doc || width === lastWidth) return;
          lastWidth = width;
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => layout(), 120);
        })
        : null;
      resizeObserver?.observe(viewEl);

      const stopFollowingLocale = onLocaleChange(() => {
        applyToolLabels();
        if (doc) {
          applyPageLabels();
          renderTools();
          context.setMeta({ size: loaded.size, detail: tPlural('fileView.pdf.pages', pageCount, { count: pageCount }) });
        } else if (shownError) {
          showError(shownError.reason, shownError.size, shownError.mtimeMs);
        } else if (passwordAnswer) {
          showPasswordForm(passwordState);
        } else {
          showLoading();
        }
      });

      applyToolLabels();
      void open();

      return {
        async update() {
          await open();
        },
        unmount() {
          disposed = true;
          clearTimeout(loadingTimer);
          clearTimeout(resizeTimer);
          if (scrollFrame) cancelAnimationFrame(scrollFrame);
          resizeObserver?.disconnect();
          stopFollowingLocale();
          viewEl.removeEventListener('scroll', onScroll);
          viewEl.removeEventListener('keydown', onKeyDown);
          password = null;
          // A load left at the password prompt goes too, with its worker, and
          // an open() or update() still waiting for it settles (#634).
          stopPending();
          closeDocument();
        },
        /** For tests: where the view stands. */
        get state() {
          return { page: currentPage, pages: pageCount, zoom, zoomMode, rendered: [...rendering.keys()] };
        },
      };
    },
  };
}

export const pdfView = createPdfView();
