// Markdown in the file preview (#344): rendered by default, with a switch back
// to the source.
//
// The preview goes through `markdownToSafeHtml()`, the same sanitizer as the
// chat answers. What differs is only what a file needs and a chat answer does
// not: its front matter, images relative to the file, and links to other files
// of the workspace. The source is the plain-text view, mounted next to the
// preview the first time it is asked for.
//
// Decided with a mockup on 2026-09-26: a "Preview | Source" segmented control
// in the header, every file opens in the preview, the front matter as a
// key/value block, and images from the web as a placeholder with their
// address — they are never loaded (the CSP forbids it, and so does this view).
//
// The interface it implements is documented in the header of `registry.js`.

import contracts from '../generated/contracts.js';
import { t, onLocaleChange } from '../i18n.js';
import { openChatLink } from '../chat/openChatLink.js';
import { placeholderFor } from '../chat/workspaceImages.js';
import { basenameOf, parentDirOf } from '../utils/nativePath.js';
import {
  classifyLink,
  documentPathOf,
  renderMarkdownFragment,
  resolveDocumentPath,
  splitDocument,
} from './markdown-document.js';
import { MODES, buildModeSwitch } from './mode-switch.js';
import { plainTextView } from './plain-text-view.js';

const {
  isWorkspaceImageSource,
  workspaceImageDataUrl,
  workspaceImageErrorMessageKey,
  WORKSPACE_IMAGE_ERRORS,
} = contracts;

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
const NOTICE_MS = 5000;
// Every entry holds a whole image as base64, up to 10 MB each — the same
// bound as the chat's cache in workspaceImages.js (#640).
const MAX_CACHED_IMAGES = 24;
// Image reads at a time, for the same reason: a document with forty images
// must not put forty of them on the IPC channel at once (#640).
const MAX_PARALLEL_READS = 4;
// The renderer's own reason next to main's: the bytes came, but do not decode.
const BROKEN = 'broken';
// What the view sets on a link of the document. The sanitizer lets `data-*`
// through, so whatever the document wrote under these names goes first.
const LINK_DATA_ATTRIBUTES = ['data-link-kind', 'data-anchor', 'data-target', 'data-fragment'];

function buildFrontMatter(frontMatter) {
  const section = document.createElement('section');
  section.className = 'md-front-matter';
  const title = document.createElement('div');
  title.className = 'md-front-matter__title';
  title.textContent = t('fileView.markdown.frontMatter');
  // The term stays English in German too.
  title.lang = 'en';
  section.setAttribute('aria-label', title.textContent);
  section.append(title);

  if (frontMatter.raw !== undefined) {
    const pre = document.createElement('pre');
    pre.className = 'md-front-matter__raw';
    pre.textContent = frontMatter.raw;
    section.append(pre);
    return section;
  }

  const list = document.createElement('dl');
  list.className = 'md-front-matter__list';
  for (const entry of frontMatter.entries) {
    const key = document.createElement('dt');
    key.textContent = entry.key;
    const value = document.createElement('dd');
    if (entry.nested !== undefined) {
      const pre = document.createElement('pre');
      pre.className = 'md-front-matter__nested';
      pre.textContent = entry.nested;
      value.append(pre);
    } else {
      value.textContent = entry.value;
    }
    list.append(key, value);
  }
  section.append(list);
  return section;
}

export const markdownView = {
  id: 'markdown',
  kind: 'viewer',

  canHandle({ ext }) {
    return MARKDOWN_EXTENSIONS.has(ext);
  },

  mount(hostEl, context) {
    const { api } = context;
    const file = context.file;
    const fileDir = parentDirOf(file.path);
    const workspaceRoot = context.workspaceRoot ?? null;
    let content = context.content;
    let mode = MODES.PREVIEW;
    let disposed = false;
    // Every check of an image draws a number, kept on its slot: an answer for
    // an older check is dropped instead of overwriting a newer one, and one
    // for a render that has been replaced finds its slot gone.
    let imageCheck = 0;
    let noticeTimer = null;
    // Images of this file, by path, as `{ dataUrl, size, mtimeMs }`: a render
    // after an external change must not flash every image through a
    // placeholder. Starts empty per mount. An overwritten image does not
    // carry its new content in its path, so every check compares size and
    // date with the disk before it trusts an entry (#640).
    const imageCache = new Map();
    // The workspace images of the current render, see resolveImages().
    let imageSlots = [];
    // Reads of image bytes in flight, and the ones waiting for a turn.
    let activeReads = 0;
    const queuedReads = [];

    const previewEl = document.createElement('div');
    previewEl.className = 'md-view';
    previewEl.tabIndex = 0;
    const articleEl = document.createElement('article');
    articleEl.className = 'md-doc';
    previewEl.append(articleEl);

    const sourceEl = document.createElement('div');
    sourceEl.className = 'md-source';
    sourceEl.hidden = true;
    let sourceInstance = null;

    const noticeEl = document.createElement('div');
    noticeEl.className = 'md-notice';
    noticeEl.setAttribute('role', 'status');
    noticeEl.setAttribute('aria-live', 'polite');
    noticeEl.hidden = true;

    hostEl.append(previewEl, sourceEl, noticeEl);

    // Nothing is cut off (#730). Step by step, as far as the column needs:
    // a short cell keeps its line while the table fits; then every cell wraps
    // at its spaces and hyphens; and only then within its words.
    let fittedWidth = -1;
    const fitObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        const width = articleEl.clientWidth;
        if (width !== fittedWidth) fitTables();
      })
      : null;
    fitObserver?.observe(articleEl);

    function fitTables() {
      fittedWidth = articleEl.clientWidth;
      const frames = [...articleEl.querySelectorAll('.md-table-frame')];
      const overflows = (frame) => frame.scrollWidth > frame.clientWidth;
      for (const frame of frames) {
        frame.firstElementChild?.classList.remove('md-table--squeezed', 'md-table--tight');
      }
      let overflowing = frames.filter(overflows);
      for (const step of ['md-table--squeezed', 'md-table--tight']) {
        for (const frame of overflowing) frame.firstElementChild?.classList.add(step);
        overflowing = overflowing.filter(overflows);
      }
    }

    const modeSwitch = buildModeSwitch((next) => setMode(next));
    context.setTools([modeSwitch.element]);

    function showNotice(message) {
      clearTimeout(noticeTimer);
      noticeEl.textContent = message;
      noticeEl.hidden = false;
      noticeTimer = setTimeout(() => {
        noticeEl.hidden = true;
        noticeEl.textContent = '';
      }, NOTICE_MS);
    }

    function setMode(next) {
      if (next === mode || disposed) return;
      mode = next;
      modeSwitch.select(mode);
      if (mode === MODES.SOURCE && !sourceInstance) {
        sourceInstance = plainTextView.mount(sourceEl, { ...context, content });
      }
      previewEl.hidden = mode !== MODES.PREVIEW;
      sourceEl.hidden = mode !== MODES.SOURCE;
    }

    /**
     * `keepImages`: a language switch renders the text anew, but what the
     * images show has not changed — each one takes over its predecessor's
     * state instead of asking main again (#640).
     */
    function render({ keepImages = false } = {}) {
      const previous = keepImages ? new Map(imageSlots.map((slot) => [slot.target, slot])) : null;
      const { frontMatter, body } = splitDocument(content);
      const nodes = [];
      if (frontMatter) nodes.push(buildFrontMatter(frontMatter));

      if (!frontMatter && !body.trim()) {
        const empty = document.createElement('p');
        empty.className = 'md-empty';
        empty.textContent = t('fileView.markdown.empty');
        nodes.push(empty);
      } else {
        nodes.push(renderMarkdownFragment(body));
      }

      // Same element, new children: the scroll position survives an external
      // change as far as the new length allows, as in the plain-text view.
      const scrollTop = previewEl.scrollTop;
      articleEl.replaceChildren(...nodes);
      prepareLinks();
      fitTables();
      previewEl.scrollTop = scrollTop;
      return resolveImages(previous);
    }

    function prepareLinks() {
      for (const anchor of articleEl.querySelectorAll('a')) {
        const link = classifyLink(anchor);
        anchor.removeAttribute('data-workspace-href');
        for (const name of LINK_DATA_ATTRIBUTES) anchor.removeAttribute(name);
        if (!link) {
          anchor.removeAttribute('href');
          anchor.removeAttribute('target');
          continue;
        }
        anchor.dataset.linkKind = link.kind;
        if (link.kind === 'external') {
          anchor.classList.add('md-link--external');
          anchor.title = link.href;
          continue;
        }
        // Not a real address: the click is handled here, and a stray middle
        // click must not open a window for a relative path.
        anchor.setAttribute('href', '#');
        anchor.removeAttribute('target');
        if (link.kind === 'anchor') {
          anchor.dataset.anchor = link.slug;
        } else {
          anchor.dataset.target = link.target;
          anchor.dataset.fragment = link.fragment;
          // The path as it was written, not as marked encoded it (#641).
          anchor.title = documentPathOf(link.target);
        }
      }
    }

    /**
     * Decides every image of a fresh render. The ones that live in the
     * workspace become slots — `{ img, placeholder, target, alt, shown,
     * reason, check }` — which `refreshImages()` can check again later
     * without rendering the document anew, so that a reader's selection and
     * focus survive it. `previous` holds the slots of the render before, by
     * path, when their state is to be taken over.
     */
    function resolveImages(previous) {
      imageSlots = [];
      const unchecked = [];
      for (const img of articleEl.querySelectorAll('img[data-md-src]')) {
        const raw = (img.getAttribute('data-md-src') ?? '').trim();
        const alt = img.getAttribute('alt') || '';
        img.removeAttribute('data-md-src');
        const slot = { img, placeholder: null, target: null, alt, shown: null, reason: null, check: 0 };

        if (/^data:image\//i.test(raw)) {
          // Carries its own bytes; the CSP allows `data:` images.
          place(slot, { dataUrl: raw });
          continue;
        }
        if (!isWorkspaceImageSource(raw)) {
          const fromWeb = /^https?:/i.test(raw);
          img.replaceWith(placeholderFor(
            alt,
            t(fromWeb ? 'fileView.markdown.image.remote' : 'chat.image.externalSource'),
            { detail: raw },
          ));
          continue;
        }
        slot.target = resolveDocumentPath(raw, { fileDir, workspaceRoot });
        imageSlots.push(slot);
        const before = previous?.get(slot.target);
        if (before?.shown) {
          place(slot, { dataUrl: before.shown });
          continue;
        }
        if (before?.reason) {
          showPlaceholder(slot, before.reason);
          continue;
        }
        // What was on show stays on show while it is checked again.
        const cached = slot.target ? imageCache.get(slot.target) : undefined;
        if (cached) place(slot, cached);
        unchecked.push(slot);
      }
      return refreshImages(unchecked);
    }

    /**
     * Checks images against the disk again (#640) — those of a render, or on
     * a revalidation those in the folders a watcher reported. One listing per
     * folder and one read per path, however often the document shows them.
     */
    function refreshImages(slots) {
      const check = ++imageCheck;
      const byTarget = new Map();
      for (const slot of slots) {
        slot.check = check;
        if (!slot.target) {
          place(slot, { reason: WORKSPACE_IMAGE_ERRORS.NOT_FOUND });
          continue;
        }
        if (!byTarget.has(slot.target)) byTarget.set(slot.target, []);
        byTarget.get(slot.target).push(slot);
      }
      const listings = new Map();
      return Promise.all([...byTarget].map(async ([target, group]) => {
        const entry = await checkImage(target, listings);
        for (const slot of group) {
          // A newer check of this slot, or a newer render, has the last word.
          if (!disposed && slot.check === check && imageSlots.includes(slot)) place(slot, entry);
        }
      })).then(() => undefined);
    }

    /**
     * The image at `target`. A cached one is first compared by size and
     * modification time with a listing of its folder — one cheap call
     * instead of up to 10 MB of base64 — and only read again when it differs.
     */
    async function checkImage(target, listings) {
      const cached = imageCache.get(target);
      if (cached && await unchangedOnDisk(target, cached, listings)) {
        remember(target, cached);
        return cached;
      }
      return readImage(target);
    }

    async function unchangedOnDisk(target, cached, listings) {
      if (typeof api?.readDirectory !== 'function') return false;
      const dir = parentDirOf(target);
      if (!listings.has(dir)) {
        listings.set(dir, Promise.resolve()
          .then(() => api.readDirectory(dir, { showHidden: true }))
          .then((listing) => listing?.entries ?? [], () => []));
      }
      const name = basenameOf(target);
      const entry = (await listings.get(dir)).find((candidate) => candidate?.name === name && !candidate.isDirectory);
      // A listing carries `lstat`: a symbolic link shows its own size and
      // date, never matches, and is read every time — slower, but right. So
      // is a file the listing left out past its limit.
      return Boolean(entry) && entry.size === cached.size && entry.modified === cached.mtimeMs;
    }

    /** Reads an image and remembers it. At most a few reads run at once. */
    async function readImage(target) {
      await takeReadTurn();
      let result = null;
      try {
        if (!disposed && typeof api?.readWorkspaceImage === 'function') {
          result = await api.readWorkspaceImage(target);
        }
      } catch {
        result = null;
      } finally {
        passReadTurn();
      }
      if (!result?.ok) {
        imageCache.delete(target);
        return { reason: result?.reason ?? WORKSPACE_IMAGE_ERRORS.NOT_FOUND };
      }
      const dataUrl = workspaceImageDataUrl(result);
      const before = imageCache.get(target);
      const entry = {
        dataUrl,
        size: result.size,
        mtimeMs: result.mtimeMs,
        // The same bytes that failed to decode before fail again.
        broken: before?.dataUrl === dataUrl && before.broken === true,
      };
      remember(target, entry);
      return entry;
    }

    /** Most recently used last; the oldest goes first. */
    function remember(target, entry) {
      imageCache.delete(target);
      imageCache.set(target, entry);
      while (imageCache.size > MAX_CACHED_IMAGES) imageCache.delete(imageCache.keys().next().value);
    }

    function takeReadTurn() {
      if (activeReads < MAX_PARALLEL_READS) {
        activeReads += 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => queuedReads.push(resolve));
    }

    function passReadTurn() {
      const next = queuedReads.shift();
      if (next) next();
      else activeReads -= 1;
    }

    /**
     * Puts an image or the reason it is missing where the slot stands. An
     * unchanged image is never swapped for itself, and an unchanged reason
     * keeps its node — a selection across it survives a revalidation.
     */
    function place(slot, entry) {
      if (entry.broken) {
        showPlaceholder(slot, BROKEN);
        return;
      }
      if (!entry.dataUrl) {
        showPlaceholder(slot, entry.reason);
        return;
      }
      if (slot.placeholder) {
        slot.placeholder.replaceWith(slot.img);
        slot.placeholder = null;
        slot.reason = null;
      }
      if (slot.shown === entry.dataUrl) return;
      slot.shown = entry.dataUrl;
      showImage(slot, entry.dataUrl);
    }

    function showPlaceholder(slot, reason) {
      if (slot.placeholder && slot.reason === reason) return;
      const message = reason === BROKEN
        ? t('fileView.markdown.image.broken')
        : t(workspaceImageErrorMessageKey(reason));
      const placeholder = placeholderFor(slot.alt, message);
      (slot.placeholder ?? slot.img).replaceWith(placeholder);
      slot.placeholder = placeholder;
      slot.reason = reason;
      slot.shown = null;
    }

    function showImage(slot, src) {
      const { img, target } = slot;
      img.classList.add('md-image');
      img.setAttribute('decoding', 'async');
      // Main checks the signature, not the whole file: a damaged PNG still
      // arrives, and ends in the same placeholder as one that cannot be read
      // instead of Chromium's broken-image icon (#640). The cache remembers,
      // so that the same bytes are not tried again.
      img.onerror = () => {
        if (slot.shown !== src) return;
        const cached = target ? imageCache.get(target) : undefined;
        if (cached?.dataUrl === src) cached.broken = true;
        if (disposed || !img.isConnected) return;
        showPlaceholder(slot, BROKEN);
      };
      img.src = src;
    }

    async function followLink(anchor) {
      const kind = anchor.dataset.linkKind;
      if (kind === 'external') {
        const result = await openChatLink(api, anchor.getAttribute('href'));
        if (!result.ok && !disposed) showNotice(result.error);
        return;
      }
      if (kind === 'anchor') {
        revealHeading(anchor.dataset.anchor);
        return;
      }
      if (kind === 'file') {
        const raw = anchor.dataset.target;
        const fragment = anchor.dataset.fragment ?? '';
        const target = resolveDocumentPath(raw, { fileDir, workspaceRoot });
        // `README.md#setup` inside README.md: an anchor with the file name
        // in front of it.
        if (target === file.path && fragment) {
          revealHeading(fragment);
          return;
        }
        // The fragment travels with the path, and the view of the other file
        // scrolls to it once it is mounted (#641).
        const result = target && typeof context.openFile === 'function'
          ? await context.openFile(target, { fragment })
          : { ok: false, reason: 'not-found' };
        if (disposed || result?.ok) return;
        showNotice(t(result?.reason === 'outside'
          ? 'fileView.markdown.link.outside'
          : 'fileView.markdown.link.notFound', { path: documentPathOf(raw) }));
      }
    }

    function headingFor(slug) {
      return [...articleEl.querySelectorAll('[data-md-anchor]')]
        .find((el) => el.getAttribute('data-md-anchor') === slug) ?? null;
    }

    /**
     * Scrolls to a heading and gives it the focus, so that the next Tab goes
     * on from there instead of back to the link (WCAG 2.4.3, #641). It only
     * becomes focusable by script; the ring follows `:focus-visible`, so it
     * shows after Enter and not after a click. False when there is no such
     * heading — then a notice says so.
     */
    function revealHeading(slug) {
      const heading = headingFor(slug);
      if (!heading) {
        showNotice(t('fileView.markdown.link.noAnchor', { anchor: `#${slug}` }));
        return false;
      }
      heading.scrollIntoView({ block: 'start' });
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      return true;
    }

    /**
     * The fragment of the link this file was opened through. Images above the
     * heading arrive after it and push it down: once they are in, the heading
     * is put back on top — unless the reader has scrolled in the meantime.
     */
    function revealOnOpen(slug, imagesSettled) {
      if (!revealHeading(slug)) return;
      const scrolledTo = previewEl.scrollTop;
      void imagesSettled.then(() => {
        if (disposed || previewEl.scrollTop !== scrolledTo) return;
        headingFor(slug)?.scrollIntoView({ block: 'start' });
      });
    }

    function onClick(event) {
      const anchor = event.target.closest?.('a');
      if (!anchor || !articleEl.contains(anchor)) return;
      event.preventDefault();
      if (!anchor.dataset.linkKind) return;
      void followLink(anchor);
    }

    // Only the primary click follows a link. A middle click would ask the
    // window for a new one — for a relative path there is nothing to open.
    function onAuxClick(event) {
      if (event.target.closest?.('a') && articleEl.contains(event.target)) event.preventDefault();
    }

    previewEl.addEventListener('click', onClick);
    previewEl.addEventListener('auxclick', onAuxClick);

    const stopFollowingLocale = onLocaleChange(() => {
      modeSwitch.applyLabels();
      void render({ keepImages: true });
    });

    const firstImages = render();
    if (context.fragment) revealOnOpen(context.fragment, firstImages);

    return {
      update({ content: next }) {
        content = next;
        void render();
        sourceInstance?.update({ content: next });
      },
      /**
       * The text is unchanged, the images it shows may not be (#640): the
       * host calls this on a refresh that finds the same text, and for a
       * watcher report of other folders with those folders — then only the
       * images in them are checked. Only what differs is swapped; the
       * document is not rendered anew, so selection, focus and scroll stay.
       */
      revalidate({ directories } = {}) {
        const slots = Array.isArray(directories)
          ? imageSlots.filter((slot) => slot.target && directories.includes(parentDirOf(slot.target)))
          : imageSlots;
        return refreshImages(slots);
      },
      unmount() {
        disposed = true;
        fitObserver?.disconnect();
        clearTimeout(noticeTimer);
        stopFollowingLocale();
        previewEl.removeEventListener('click', onClick);
        previewEl.removeEventListener('auxclick', onAuxClick);
        sourceInstance?.unmount();
      },
      /** Commands from outside the view — the menu shortcut (#344). */
      command(name) {
        if (name !== 'toggle-source') return false;
        setMode(mode === MODES.PREVIEW ? MODES.SOURCE : MODES.PREVIEW);
        return true;
      },
      /** For tests: which of the two is on show. */
      get mode() {
        return mode;
      },
    };
  },
};
