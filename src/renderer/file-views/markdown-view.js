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
import { parentDirOf } from '../utils/nativePath.js';
import {
  classifyLink,
  renderMarkdownFragment,
  resolveDocumentPath,
  splitDocument,
} from './markdown-document.js';
import { plainTextView } from './plain-text-view.js';

const {
  isWorkspaceImageSource,
  workspaceImageDataUrl,
  workspaceImageErrorMessageKey,
  WORKSPACE_IMAGE_ERRORS,
} = contracts;

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
const NOTICE_MS = 5000;
export const MODES = Object.freeze({ PREVIEW: 'preview', SOURCE: 'source' });

// Radio groups need a name that is unique in the window; a counter is enough.
let instanceCount = 0;

function buildModeSwitch(name, onChange) {
  const group = document.createElement('div');
  group.className = 'ds-segmented ds-segmented--compact md-mode-switch';
  group.setAttribute('role', 'radiogroup');

  const options = {};
  for (const mode of [MODES.PREVIEW, MODES.SOURCE]) {
    const label = document.createElement('label');
    label.className = 'ds-segmented__option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.className = 'ds-segmented__input';
    input.name = name;
    input.value = mode;
    input.checked = mode === MODES.PREVIEW;
    input.addEventListener('change', () => {
      if (input.checked) onChange(mode);
    });
    const text = document.createElement('span');
    label.append(input, text);
    group.append(label);
    options[mode] = { input, text };
  }
  // "Preview" is English in both languages (decided 2026-09-26).
  options[MODES.PREVIEW].text.lang = 'en';

  function applyLabels() {
    group.setAttribute('aria-label', t('fileView.markdown.mode.label'));
    options[MODES.PREVIEW].text.textContent = t('fileView.markdown.mode.preview');
    options[MODES.SOURCE].text.textContent = t('fileView.markdown.mode.source');
  }
  applyLabels();

  return {
    element: group,
    applyLabels,
    select(mode) {
      options[mode].input.checked = true;
    },
  };
}

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
    // Every render draws a number; an image that arrives for an older render
    // is dropped instead of being put into the new one.
    let renderGeneration = 0;
    let noticeTimer = null;
    // Images of this file, by path: a render after an external change must
    // not flash every image through a placeholder. Starts empty per mount.
    const imageCache = new Map();

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

    instanceCount += 1;
    const modeSwitch = buildModeSwitch(`md-mode-${instanceCount}`, (next) => setMode(next));
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

    function render() {
      const generation = ++renderGeneration;
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
      previewEl.scrollTop = scrollTop;
      void resolveImages(generation);
    }

    function prepareLinks() {
      for (const anchor of articleEl.querySelectorAll('a')) {
        const link = classifyLink(anchor);
        anchor.removeAttribute('data-workspace-href');
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
          anchor.title = link.target;
        }
      }
    }

    async function resolveImages(generation) {
      const images = [...articleEl.querySelectorAll('img[data-md-src]')];
      await Promise.all(images.map((img) => resolveImage(img, generation)));
    }

    async function resolveImage(img, generation) {
      const raw = img.getAttribute('data-md-src') ?? '';
      const alt = img.getAttribute('alt') || '';
      img.removeAttribute('data-md-src');

      if (/^data:image\//i.test(raw.trim())) {
        // Carries its own bytes; the CSP allows `data:` images.
        showImage(img, raw.trim());
        return;
      }
      if (!isWorkspaceImageSource(raw)) {
        const fromWeb = /^https?:/i.test(raw.trim());
        img.replaceWith(placeholderFor(
          alt,
          t(fromWeb ? 'fileView.markdown.image.remote' : 'chat.image.externalSource'),
          { detail: raw.trim() },
        ));
        return;
      }

      const target = resolveDocumentPath(raw, { fileDir, workspaceRoot });
      let entry = target ? imageCache.get(target) : null;
      if (!entry) {
        let result = null;
        if (target && typeof api?.readWorkspaceImage === 'function') {
          try {
            result = await api.readWorkspaceImage(target);
          } catch {
            result = null;
          }
        }
        entry = result?.ok
          ? { dataUrl: workspaceImageDataUrl(result) }
          : { reason: result?.reason ?? WORKSPACE_IMAGE_ERRORS.NOT_FOUND };
        if (target && entry.dataUrl) imageCache.set(target, entry);
      }
      if (disposed || generation !== renderGeneration || !img.isConnected) return;
      if (entry.dataUrl) showImage(img, entry.dataUrl);
      else img.replaceWith(placeholderFor(alt, t(workspaceImageErrorMessageKey(entry.reason))));
    }

    function showImage(img, src) {
      img.classList.add('md-image');
      img.setAttribute('decoding', 'async');
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
        const slug = anchor.dataset.anchor;
        const heading = [...articleEl.querySelectorAll('[data-md-anchor]')]
          .find((el) => el.getAttribute('data-md-anchor') === slug);
        if (heading) heading.scrollIntoView({ block: 'start' });
        else showNotice(t('fileView.markdown.link.noAnchor', { anchor: `#${slug}` }));
        return;
      }
      if (kind === 'file') {
        const raw = anchor.dataset.target;
        const target = resolveDocumentPath(raw, { fileDir, workspaceRoot });
        const result = target && typeof context.openFile === 'function'
          ? await context.openFile(target)
          : { ok: false, reason: 'not-found' };
        if (disposed || result?.ok) return;
        showNotice(t(result?.reason === 'outside'
          ? 'fileView.markdown.link.outside'
          : 'fileView.markdown.link.notFound', { path: raw }));
      }
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
      render();
    });

    render();

    return {
      update({ content: next }) {
        content = next;
        render();
        sourceInstance?.update({ content: next });
      },
      unmount() {
        disposed = true;
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
