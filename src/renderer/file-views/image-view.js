// Images in the file preview (#345): PNG, JPEG, GIF, WebP and SVG.
//
// The bytes come through `fs:readWorkspaceImage` (#244), the same channel the
// chat uses for images the model writes: the main process checks the path
// lexically and through `realpath`, decides the type by the content, holds the
// 10 MB limit and hands back a `data:` URI or a reason — never a path the
// renderer would have to trust. The view therefore declares `reads: 'none'`,
// and the host leaves the file alone.
//
// SVG is only ever shown through `<img>`: no script in it runs there and no
// reference in it is fetched. It is never inlined into the DOM. Its markup is
// parsed once, with DOMParser and without being attached, to learn the size
// it declares. Next to the picture it keeps its source, behind the same
// "Preview | Source" switch as Markdown.
//
// Decided with a mockup on 2026-09-27: the image opens fitted to the column
// and never upscaled. A checkerboard sits behind the image only, so that
// transparency shows in light and dark alike.
//
// Since #803 the zoom lives in the header only — the same "− 100 % + Fit"
// group as in the PDF preview, plus Cmd/Ctrl +, − and 0 while the image has
// focus. A click no longer zooms: when the image is larger than the column, a
// drag with the left button moves it under a hand cursor, and the arrow keys
// scroll it. When it fits, there is nothing to move.
//
// The interface it implements is documented in the header of `registry.js`.

import contracts from '../generated/contracts.js';
import { t, onLocaleChange } from '../i18n.js';
import { formatSize } from '../utils/helpers.js';
import { MODES, buildModeSwitch } from './mode-switch.js';
import { plainTextView } from './plain-text-view.js';
import { readFailureMessageKey, readFailureOf } from './read-failures.js';
import { ZOOM_IN_ICON, ZOOM_OUT_ICON, ZOOM_STEPS, iconButton, nextZoom } from './zoom-tools.js';

const { MAX_WORKSPACE_IMAGE_BYTES, WORKSPACE_IMAGE_ERRORS, workspaceImageDataUrl } = contracts;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const SVG_MIME = 'image/svg+xml';
// Only a read that takes longer than this gets a loading line; below it, the
// line would only flicker.
const LOADING_DELAY_MS = 200;
// Must match the padding of `.img-view` in styles.css: the image fits into
// the column minus this, on each side.
const VIEW_PADDING_PX = 24;

// Reason from the main process → catalogue key of the error card. A decode
// failure in the renderer ('broken') is not a reason the main process knows.
const ERROR_KEYS = Object.freeze({
  [WORKSPACE_IMAGE_ERRORS.NO_WORKSPACE]: 'noWorkspace',
  [WORKSPACE_IMAGE_ERRORS.OUTSIDE_WORKSPACE]: 'outsideWorkspace',
  [WORKSPACE_IMAGE_ERRORS.NOT_FOUND]: 'notFound',
  [WORKSPACE_IMAGE_ERRORS.UNSUPPORTED_TYPE]: 'unsupportedType',
  [WORKSPACE_IMAGE_ERRORS.TOO_LARGE]: 'tooLarge',
  broken: 'broken',
});

/** A length in an SVG `width`/`height`, in pixels — or null for %, em, cm … */
function svgLength(value) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(value ?? '');
  const number = match ? Number(match[1]) : NaN;
  return number > 0 ? number : null;
}

/**
 * The size an SVG declares: `width` and `height` in pixels, else the
 * `viewBox`. Chromium gives an SVG without its own size a default of 300 × 150
 * as `naturalWidth`, which says nothing about the drawing.
 */
export function svgDimensions(markup) {
  let root;
  try {
    root = new DOMParser().parseFromString(markup, SVG_MIME).documentElement;
  } catch {
    return null;
  }
  if (!root || root.localName !== 'svg') return null;
  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const boxWidth = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : null;
  const boxHeight = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3] : null;
  let width = svgLength(root.getAttribute('width'));
  let height = svgLength(root.getAttribute('height'));
  // One side given, the other from the aspect ratio of the viewBox.
  if (width && !height && boxWidth && boxHeight) height = (width * boxHeight) / boxWidth;
  if (height && !width && boxWidth && boxHeight) width = (height * boxWidth) / boxHeight;
  width ??= boxWidth;
  height ??= boxHeight;
  return width && height ? { width: Math.round(width), height: Math.round(height) } : null;
}

function decodeBase64Utf8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * The scale at which an image of `natural` size fits into `available`,
 * never above 1. Null while the column has no size (hidden, not laid out).
 */
export function fitScale(natural, available) {
  if (!natural || available.width <= 0 || available.height <= 0) return null;
  return Math.min(1, available.width / natural.width, available.height / natural.height);
}

export const imageView = {
  id: 'image',
  kind: 'viewer',
  reads: 'none',

  canHandle({ ext }) {
    return IMAGE_EXTENSIONS.has(ext);
  },

  mount(hostEl, context) {
    const { api, file } = context;
    const isSvg = file.ext === 'svg';
    let disposed = false;
    let mode = MODES.PREVIEW;
    // What is on show: { dataUrl, mime, size, mtimeMs, natural } or
    // { reason, size }. Null before the first read has answered.
    let shown = null;
    // 'fit' follows the column; otherwise `zoom` is a fixed factor.
    let zoomMode = 'fit';
    let zoom = 1;
    // A drag that moves the image: where it started, and the scroll then.
    let drag = null;
    let loadingTimer = null;
    // Every read draws a number; an answer for an older one is dropped.
    let readGeneration = 0;
    // The same for the source of an SVG (#641), and why it is not shown.
    let sourceGeneration = 0;
    let sourceFailure = null;

    const viewEl = document.createElement('div');
    viewEl.className = 'img-view';
    const imgEl = document.createElement('img');
    imgEl.className = 'img-view__image';
    imgEl.alt = file.name;
    imgEl.decoding = 'async';
    imgEl.draggable = false;
    imgEl.hidden = true;
    const messageEl = document.createElement('div');
    messageEl.className = 'img-view__message';
    messageEl.setAttribute('role', 'status');
    messageEl.hidden = true;
    viewEl.append(imgEl, messageEl);

    const sourceEl = document.createElement('div');
    sourceEl.className = 'md-source';
    sourceEl.hidden = true;
    let sourceInstance = null;
    // The text and the reason it is missing take turns; the reason is a
    // state of its own, never the file's content in the monospace pane.
    const sourceTextEl = document.createElement('div');
    sourceTextEl.className = 'img-source__text';
    const sourceMessageEl = document.createElement('div');
    sourceMessageEl.className = 'img-view__message img-source__message';
    sourceMessageEl.setAttribute('role', 'status');
    sourceMessageEl.hidden = true;
    sourceEl.append(sourceTextEl, sourceMessageEl);

    // Says the zoom after the user changed it — and only then, as in the PDF
    // preview (#641): a re-fit for a resized column stays silent.
    const announcerEl = document.createElement('p');
    announcerEl.className = 'sr-only img-view__announcer';
    announcerEl.setAttribute('role', 'status');

    hostEl.append(viewEl, sourceEl, announcerEl);

    const modeSwitch = isSvg ? buildModeSwitch((next) => setMode(next)) : null;

    // ── Header tools: zoom ────────────────────────────────────────────────

    const zoomEl = document.createElement('div');
    zoomEl.className = 'pdf-tools img-zoom';
    zoomEl.setAttribute('role', 'group');
    const zoomOutButton = iconButton('pdf-tools__zoom-out', ZOOM_OUT_ICON);
    const zoomValue = document.createElement('output');
    zoomValue.className = 'pdf-tools__zoom';
    zoomValue.setAttribute('aria-live', 'off');
    const zoomInButton = iconButton('pdf-tools__zoom-in', ZOOM_IN_ICON);
    const fitButton = document.createElement('button');
    fitButton.type = 'button';
    fitButton.className = 'pdf-tools__button pdf-tools__fit';
    zoomEl.append(zoomOutButton, zoomValue, zoomInButton, fitButton);

    function applyToolLabels() {
      zoomEl.setAttribute('aria-label', t('fileView.image.zoom.label'));
      zoomOutButton.setAttribute('aria-label', t('fileView.image.zoom.out'));
      zoomOutButton.title = zoomOutButton.getAttribute('aria-label');
      zoomInButton.setAttribute('aria-label', t('fileView.image.zoom.in'));
      zoomInButton.title = zoomInButton.getAttribute('aria-label');
      fitButton.textContent = t('fileView.image.zoom.fit');
      fitButton.title = t('fileView.image.zoom.fitTitle');
    }

    function renderZoomTools() {
      zoomValue.textContent = `${Math.round(zoom * 100)}\u00a0%`;
      zoomOutButton.disabled = zoom <= ZOOM_STEPS[0] + 0.001;
      zoomInButton.disabled = zoom >= ZOOM_STEPS.at(-1) - 0.001;
      fitButton.setAttribute('aria-pressed', String(zoomMode === 'fit'));
    }

    /** The header: the mode switch of an SVG, and the zoom while a picture is on show. */
    function showTools() {
      const zoomable = mode === MODES.PREVIEW && Boolean(shown?.natural);
      const nodes = [modeSwitch?.element, zoomable ? zoomEl : null].filter(Boolean);
      context.setTools(nodes.length ? nodes : null);
    }

    applyToolLabels();
    showTools();

    zoomOutButton.addEventListener('click', () => setZoom(nextZoom(zoom, -1)));
    zoomInButton.addEventListener('click', () => setZoom(nextZoom(zoom, 1)));
    fitButton.addEventListener('click', () => setZoom('fit'));

    // ── Layout: zoom and panning ──────────────────────────────────────────

    function availableSize() {
      return {
        width: viewEl.clientWidth - 2 * VIEW_PADDING_PX,
        height: viewEl.clientHeight - 2 * VIEW_PADDING_PX,
      };
    }

    function layout() {
      const natural = shown?.natural;
      if (!natural) return;
      const available = availableSize();
      const fit = fitScale(natural, available);
      // Without a laid-out column there is nothing to fit into; the size is
      // set as soon as the column has one (ResizeObserver).
      if (fit === null) return;
      if (zoomMode === 'fit') zoom = fit;
      const width = Math.max(1, Math.round(natural.width * zoom));
      const height = Math.max(1, Math.round(natural.height * zoom));
      imgEl.style.width = `${width}px`;
      imgEl.style.height = `${height}px`;
      applyPannable(width > available.width + 0.5 || height > available.height + 0.5);
      renderZoomTools();
    }

    /**
     * Larger than the column: a hand cursor and a drag that moves it. The view
     * takes focus while a picture is on show, for the zoom keys, and names the
     * arrow keys once there is something to scroll. A focused view keeps its
     * focus across a zoom back to the fit.
     */
    function applyPannable(pannable) {
      viewEl.classList.toggle('img-view--pannable', pannable);
      if (!pannable) endDrag();
      if (shown?.natural) {
        viewEl.tabIndex = 0;
        viewEl.setAttribute('role', 'group');
        viewEl.setAttribute('aria-label', pannable ? t('fileView.image.pan.label', { name: file.name }) : file.name);
      } else {
        viewEl.removeAttribute('tabindex');
        viewEl.removeAttribute('role');
        viewEl.removeAttribute('aria-label');
      }
      if (pannable) viewEl.title = t('fileView.image.pan.hint');
      else viewEl.removeAttribute('title');
    }

    /**
     * A fixed factor, or back to 'fit'. The point in the middle of the column
     * stays where it is, so that zooming does not lose the place.
     */
    function setZoom(next) {
      if (!shown?.natural) return;
      const before = { width: imgEl.offsetWidth, height: imgEl.offsetHeight };
      const centre = before.width > 0 && before.height > 0
        ? {
          x: (viewEl.scrollLeft + viewEl.clientWidth / 2 - imgEl.offsetLeft) / before.width,
          y: (viewEl.scrollTop + viewEl.clientHeight / 2 - imgEl.offsetTop) / before.height,
        }
        : { x: 0.5, y: 0.5 };
      if (next === 'fit') {
        zoomMode = 'fit';
      } else {
        zoomMode = 'fixed';
        zoom = next;
      }
      layout();
      viewEl.scrollLeft = imgEl.offsetLeft + centre.x * imgEl.offsetWidth - viewEl.clientWidth / 2;
      viewEl.scrollTop = imgEl.offsetTop + centre.y * imgEl.offsetHeight - viewEl.clientHeight / 2;
      announcerEl.textContent = zoomValue.textContent;
    }

    function onPointerDown(event) {
      if (event.button !== 0 || !viewEl.classList.contains('img-view--pannable')) return;
      event.preventDefault();
      viewEl.focus({ preventScroll: true });
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: viewEl.scrollLeft,
        top: viewEl.scrollTop,
      };
      viewEl.setPointerCapture?.(event.pointerId);
      viewEl.classList.add('img-view--dragging');
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.id) return;
      viewEl.scrollLeft = drag.left - (event.clientX - drag.x);
      viewEl.scrollTop = drag.top - (event.clientY - drag.y);
    }

    function endDrag(event) {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      if (viewEl.hasPointerCapture?.(drag.id)) viewEl.releasePointerCapture(drag.id);
      drag = null;
      viewEl.classList.remove('img-view--dragging');
    }

    function onKeyDown(event) {
      if (event.altKey || !shown?.natural) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key === '+' || event.key === '=') setZoom(nextZoom(zoom, 1));
      else if (event.key === '-') setZoom(nextZoom(zoom, -1));
      else if (event.key === '0') setZoom('fit');
      else return;
      event.preventDefault();
    }

    viewEl.addEventListener('pointerdown', onPointerDown);
    viewEl.addEventListener('pointermove', onPointerMove);
    viewEl.addEventListener('pointerup', endDrag);
    viewEl.addEventListener('pointercancel', endDrag);
    viewEl.addEventListener('lostpointercapture', endDrag);
    viewEl.addEventListener('keydown', onKeyDown);

    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
    resizeObserver?.observe(viewEl);

    // ── States ────────────────────────────────────────────────────────────

    function showMessage(title, detail) {
      imgEl.hidden = true;
      imgEl.removeAttribute('src');
      applyPannable(false);
      showTools();
      const titleEl = document.createElement('strong');
      titleEl.className = 'img-view__message-title';
      titleEl.textContent = title;
      const nodes = [titleEl];
      if (detail) {
        const detailEl = document.createElement('span');
        detailEl.className = 'img-view__message-detail';
        detailEl.textContent = detail;
        nodes.push(detailEl);
      }
      messageEl.replaceChildren(...nodes);
      messageEl.hidden = false;
    }

    function renderError() {
      const key = ERROR_KEYS[shown.reason] ?? ERROR_KEYS[WORKSPACE_IMAGE_ERRORS.NOT_FOUND];
      showMessage(
        t(`fileView.image.error.${key}.title`),
        t(`fileView.image.error.${key}.detail`, {
          // "10.0 MB" stays on one line: a unit alone on the next one reads
          // like a leftover.
          limit: formatSize(MAX_WORKSPACE_IMAGE_BYTES).replace(' ', '\u00a0'),
          size: formatSize(shown.size ?? file.size).replace(' ', '\u00a0'),
        }),
      );
      context.setMeta({ size: shown.size ?? file.size, detail: null });
    }

    function renderDimensions() {
      const natural = shown?.natural;
      context.setMeta({
        size: shown?.size,
        detail: natural ? `${natural.width} × ${natural.height}` : null,
      });
    }

    function showLoading() {
      clearTimeout(loadingTimer);
      loadingTimer = setTimeout(() => {
        if (!disposed && !shown) showMessage(t('fileView.image.loading'));
      }, LOADING_DELAY_MS);
    }

    /** Puts the bytes into the `<img>` and waits for Chromium to decode them. */
    function display(entry) {
      clearTimeout(loadingTimer);
      shown = entry;
      if (entry.reason) {
        renderError();
        return;
      }
      imgEl.onload = () => {
        if (disposed || shown !== entry) return;
        // A raster image's size is what Chromium decoded; an SVG keeps the
        // size its markup declares, if it declares one.
        if (entry.mime !== SVG_MIME || !entry.natural) {
          entry.natural = imgEl.naturalWidth > 0
            ? { width: imgEl.naturalWidth, height: imgEl.naturalHeight }
            : null;
        }
        messageEl.hidden = true;
        imgEl.hidden = false;
        layout();
        showTools();
        renderDimensions();
      };
      imgEl.onerror = () => {
        if (disposed || shown !== entry) return;
        shown = { reason: 'broken', size: entry.size };
        renderError();
      };
      imgEl.src = entry.dataUrl;
    }

    async function read() {
      const generation = ++readGeneration;
      if (!shown) showLoading();
      let result = null;
      try {
        result = await api.readWorkspaceImage(file.path);
      } catch {
        result = null;
      }
      if (disposed || generation !== readGeneration) return;
      if (!result?.ok) {
        display({ reason: result?.reason ?? WORKSPACE_IMAGE_ERRORS.NOT_FOUND, size: result?.size });
        return;
      }
      // Unchanged on disk: keep what is on show, including the zoom
      // and the scroll position — a click on the open file must not flash.
      if (shown?.dataUrl && shown.mtimeMs === result.mtimeMs && shown.size === result.size) return;
      const entry = {
        dataUrl: workspaceImageDataUrl(result),
        mime: result.mime,
        size: result.size,
        mtimeMs: result.mtimeMs,
        natural: null,
      };
      if (result.mime === SVG_MIME) {
        try {
          entry.natural = svgDimensions(decodeBase64Utf8(result.base64));
        } catch {
          entry.natural = null;
        }
      }
      display(entry);
    }

    // ── Source (SVG) ──────────────────────────────────────────────────────

    // An SVG between the text limit (1 MB) and the image limit (10 MB) is
    // shown as a picture, but its source is not: the reason comes from main
    // as a code and is said in the interface language (#641). Whichever read
    // started last wins, so an older answer cannot overwrite a newer one.
    async function readSource() {
      const generation = ++sourceGeneration;
      let result;
      try {
        result = await api.readFile(file.path);
      } catch {
        result = null;
      }
      if (disposed || generation !== sourceGeneration) return;
      if (!result || result.error || typeof result.content !== 'string') {
        sourceFailure = readFailureOf(result);
        renderSourceFailure();
        return;
      }
      sourceFailure = null;
      sourceMessageEl.hidden = true;
      sourceTextEl.hidden = false;
      if (sourceInstance) sourceInstance.update({ content: result.content });
      else sourceInstance = plainTextView.mount(sourceTextEl, { ...context, content: result.content });
    }

    function renderSourceFailure() {
      const titleEl = document.createElement('strong');
      titleEl.className = 'img-view__message-title';
      titleEl.textContent = t('fileView.source.unavailable');
      const detailEl = document.createElement('span');
      detailEl.className = 'img-view__message-detail';
      detailEl.textContent = t(readFailureMessageKey(sourceFailure));
      sourceMessageEl.replaceChildren(titleEl, detailEl);
      sourceMessageEl.hidden = false;
      sourceTextEl.hidden = true;
    }

    function setMode(next) {
      if (!isSvg || next === mode || disposed) return;
      mode = next;
      modeSwitch.select(mode);
      viewEl.hidden = mode !== MODES.PREVIEW;
      sourceEl.hidden = mode !== MODES.SOURCE;
      if (mode === MODES.SOURCE) void readSource();
      else layout();
      showTools();
    }

    const stopFollowingLocale = onLocaleChange(() => {
      modeSwitch?.applyLabels();
      applyToolLabels();
      if (sourceFailure) renderSourceFailure();
      if (shown?.reason) renderError();
      else if (!shown) showLoading();
      else applyPannable(viewEl.classList.contains('img-view--pannable'));
    });

    void read();

    return {
      async update() {
        await read();
        if (mode === MODES.SOURCE) await readSource();
      },
      unmount() {
        disposed = true;
        clearTimeout(loadingTimer);
        resizeObserver?.disconnect();
        stopFollowingLocale();
        endDrag();
        viewEl.removeEventListener('pointerdown', onPointerDown);
        viewEl.removeEventListener('pointermove', onPointerMove);
        viewEl.removeEventListener('pointerup', endDrag);
        viewEl.removeEventListener('pointercancel', endDrag);
        viewEl.removeEventListener('lostpointercapture', endDrag);
        viewEl.removeEventListener('keydown', onKeyDown);
        imgEl.onload = null;
        imgEl.onerror = null;
        sourceInstance?.unmount();
      },
      /** The menu shortcut (#344) — for an SVG only. */
      command(name) {
        if (name !== 'toggle-source' || !isSvg) return false;
        setMode(mode === MODES.PREVIEW ? MODES.SOURCE : MODES.PREVIEW);
        return true;
      },
      /** For tests: which of the two is on show, and at what size. */
      get mode() {
        return mode;
      },
      get zoom() {
        return { zoom, zoomMode };
      },
    };
  },
};
