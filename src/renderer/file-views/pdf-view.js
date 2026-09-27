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
// of its size from the start, so the scroll bar is right for 300 pages; an
// IntersectionObserver draws a page when it comes within one screen of the
// viewport and lets go of its canvas when it moves further away. A 300-page
// manual therefore costs a handful of canvases, not three hundred.
//
// The interface it implements is documented in the header of `registry.js`.

import contracts from '../generated/contracts.js';
import { t, tPlural, onLocaleChange } from '../i18n.js';
import { formatSize } from '../utils/helpers.js';
import { openPdfDocument } from './pdf-engine.js';

const { MAX_WORKSPACE_PDF_BYTES, WORKSPACE_PDF_ERRORS } = contracts;

// 100 % means one PDF point as 1/72 inch on a 96 dpi screen, as in every
// other PDF viewer.
const CSS_PX_PER_PT = 96 / 72;
export const ZOOM_STEPS = Object.freeze([0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]);
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

/** The next zoom step in a direction, from wherever the zoom stands now. */
export function nextZoom(current, direction) {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS.at(-1);
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0];
}

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

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function iconButton(className, path) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `pdf-tools__button ${className}`;
  button.append(icon(path));
  return button;
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
      // Every open draws a number; a document that arrives for an older one
      // is destroyed instead of shown.
      let openGeneration = 0;
      let loaded = null; // { size, mtimeMs } of what is on show
      let handle = null; // { promise, destroy } from openDocument
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

      hostEl.append(viewEl, messageEl);

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
      const zoomOutButton = iconButton('pdf-tools__zoom-out', 'M3.5 8h9');
      const zoomValue = document.createElement('output');
      zoomValue.className = 'pdf-tools__zoom';
      zoomValue.setAttribute('aria-live', 'polite');
      const zoomInButton = iconButton('pdf-tools__zoom-in', 'M3.5 8h9M8 3.5v9');
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

      let shownError = null;
      function showError(reason, size) {
        clearTimeout(loadingTimer);
        shownError = { reason, size };
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
          submit.disabled = true;
          input.disabled = true;
          answer(password);
        });
        // The form is the whole message; the title is read with it.
        showMessage([form], { role: 'group' });
        form.setAttribute('aria-label', t('fileView.pdf.password.title'));
        input.focus();
      }

      function onPassword(answer, reason) {
        if (disposed) return;
        // After a change on disk the remembered password is tried once.
        if (reason === 'need' && password && passwordState !== 'need') {
          passwordState = 'checking';
          answer(password);
          return;
        }
        passwordAnswer = answer;
        showPasswordForm(reason);
      }

      // ── Opening ─────────────────────────────────────────────────────────

      async function open() {
        const generation = ++openGeneration;
        if (!doc) showLoading();
        let result = null;
        try {
          result = await api.readWorkspacePdf(file.path);
        } catch {
          result = null;
        }
        if (disposed || generation !== openGeneration) return;
        if (!result?.ok) {
          closeDocument();
          showError(result?.reason ?? WORKSPACE_PDF_ERRORS.NOT_FOUND, result?.size);
          return;
        }
        // Unchanged on disk: keep the document, the zoom and the place.
        if (doc && loaded && loaded.mtimeMs === result.mtimeMs && loaded.size === result.size) return;

        let next;
        let nextHandle;
        try {
          nextHandle = await openDocument(api, result.bytes, { onPassword });
          if (disposed || generation !== openGeneration) {
            nextHandle.destroy();
            return;
          }
          next = await nextHandle.promise;
        } catch (err) {
          nextHandle?.destroy();
          if (disposed || generation !== openGeneration) return;
          closeDocument();
          showError('broken', result.size);
          if (err?.name !== 'InvalidPDFException') console.warn('PDF could not be opened:', err?.message ?? err);
          return;
        }
        if (disposed || generation !== openGeneration) {
          nextHandle.destroy();
          return;
        }
        const keepPage = doc ? currentPage : 1;
        closeDocument();
        handle = nextHandle;
        doc = next;
        loaded = { size: result.size, mtimeMs: result.mtimeMs };
        passwordState = null;
        shownError = null;
        await showDocument(keepPage);
      }

      function closeDocument() {
        cancelAllRenders();
        observer?.disconnect();
        pagesEl.replaceChildren();
        pageSizes.clear();
        if (handle) {
          try {
            handle.destroy();
          } catch {
            // Nothing left to let go of.
          }
        }
        handle = null;
        doc = null;
        loaded = null;
      }

      async function showDocument(startPage) {
        clearTimeout(loadingTimer);
        pageCount = doc.numPages;
        let first;
        try {
          first = await doc.getPage(1);
        } catch {
          showError('broken', loaded?.size);
          return;
        }
        if (disposed) return;
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
        const entry = { task: null };
        rendering.set(n, entry);
        try {
          const page = await doc.getPage(n);
          if (disposed || generation !== layoutGeneration || rendering.get(n) !== entry) return;
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
          showError(shownError.reason, shownError.size);
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
          passwordAnswer = null;
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
