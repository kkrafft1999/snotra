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
// Decided with a mockup on 2026-09-27: the image is fitted to the column and
// never upscaled; a click, or Enter/Space on the focused image, toggles to the
// actual size and back. No zoom beyond that. A checkerboard sits behind the
// image only, so that transparency shows in light and dark alike.
//
// The interface it implements is documented in the header of `registry.js`.

import contracts from '../generated/contracts.js';
import { t, onLocaleChange } from '../i18n.js';
import { formatSize } from '../utils/helpers.js';
import { MODES, buildModeSwitch } from './mode-switch.js';
import { plainTextView } from './plain-text-view.js';

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
    let actual = false;
    let loadingTimer = null;
    // Every read draws a number; an answer for an older one is dropped.
    let readGeneration = 0;

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

    hostEl.append(viewEl, sourceEl);

    const modeSwitch = isSvg ? buildModeSwitch((next) => setMode(next)) : null;
    if (modeSwitch) context.setTools([modeSwitch.element]);

    // ── Layout: fit or actual size ────────────────────────────────────────

    function availableSize() {
      return {
        width: viewEl.clientWidth - 2 * VIEW_PADDING_PX,
        height: viewEl.clientHeight - 2 * VIEW_PADDING_PX,
      };
    }

    function canToggle() {
      const scale = fitScale(shown?.natural, availableSize());
      return scale !== null && scale < 1;
    }

    function layout() {
      const natural = shown?.natural;
      if (!natural) return;
      const fit = fitScale(natural, availableSize());
      // Without a laid-out column there is nothing to fit into; the size is
      // set as soon as the column has one (ResizeObserver).
      if (fit === null) return;
      const toggleable = fit < 1;
      if (!toggleable) actual = false;
      const scale = actual ? 1 : fit;
      imgEl.style.width = `${Math.max(1, Math.round(natural.width * scale))}px`;
      imgEl.style.height = `${Math.max(1, Math.round(natural.height * scale))}px`;
      viewEl.classList.toggle('img-view--toggleable', toggleable);
      viewEl.classList.toggle('img-view--actual', actual);
      applyToggleLabels(toggleable);
    }

    function applyToggleLabels(toggleable = canToggle()) {
      if (toggleable) {
        viewEl.tabIndex = 0;
        viewEl.setAttribute('role', 'button');
        viewEl.setAttribute('aria-pressed', String(actual));
        viewEl.setAttribute('aria-label', t('fileView.image.toggle', { name: file.name }));
        viewEl.title = t(actual ? 'fileView.image.hint.toFit' : 'fileView.image.hint.toActual');
      } else {
        viewEl.removeAttribute('tabindex');
        viewEl.removeAttribute('role');
        viewEl.removeAttribute('aria-pressed');
        viewEl.removeAttribute('aria-label');
        viewEl.removeAttribute('title');
      }
    }

    /**
     * Fit ↔ actual size. `point` is where the image was clicked, as a
     * fraction of its width and height: at actual size that spot lands in the
     * middle of the column, so the click zooms into what was pointed at.
     */
    function toggle(point = { x: 0.5, y: 0.5 }) {
      if (!canToggle()) return;
      actual = !actual;
      layout();
      if (actual) {
        viewEl.scrollLeft = point.x * viewEl.scrollWidth - viewEl.clientWidth / 2;
        viewEl.scrollTop = point.y * viewEl.scrollHeight - viewEl.clientHeight / 2;
      }
    }

    function onImageClick(event) {
      const rect = imgEl.getBoundingClientRect();
      const point = rect.width > 0 && rect.height > 0
        ? { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
        : undefined;
      toggle(point);
    }

    function onKeyDown(event) {
      if (event.target !== viewEl || (event.key !== 'Enter' && event.key !== ' ')) return;
      if (!canToggle()) return;
      event.preventDefault();
      toggle();
    }

    imgEl.addEventListener('click', onImageClick);
    viewEl.addEventListener('keydown', onKeyDown);

    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
    resizeObserver?.observe(viewEl);

    // ── States ────────────────────────────────────────────────────────────

    function showMessage(title, detail) {
      imgEl.hidden = true;
      imgEl.removeAttribute('src');
      viewEl.classList.remove('img-view--toggleable', 'img-view--actual');
      applyToggleLabels(false);
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
      // Unchanged on disk: keep what is on show, including fit or actual size
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

    async function readSource() {
      let result;
      try {
        result = await api.readFile(file.path);
      } catch (err) {
        result = { error: err?.message ?? String(err) };
      }
      if (disposed) return;
      const text = result && !result.error ? result.content : (result?.error ?? '');
      if (sourceInstance) sourceInstance.update({ content: text });
      else sourceInstance = plainTextView.mount(sourceEl, { ...context, content: text });
    }

    function setMode(next) {
      if (!isSvg || next === mode || disposed) return;
      mode = next;
      modeSwitch.select(mode);
      viewEl.hidden = mode !== MODES.PREVIEW;
      sourceEl.hidden = mode !== MODES.SOURCE;
      if (mode === MODES.SOURCE) void readSource();
      else layout();
    }

    const stopFollowingLocale = onLocaleChange(() => {
      modeSwitch?.applyLabels();
      if (shown?.reason) renderError();
      else if (!shown) showLoading();
      else applyToggleLabels();
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
        imgEl.removeEventListener('click', onImageClick);
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
      get actualSize() {
        return actual;
      },
    };
  },
};
