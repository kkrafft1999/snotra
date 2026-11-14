// Commenting in the Markdown preview (#1388): select a passage, write a
// comment, and see the comments a file already carries.
//
// Decided in the issue on 2026-11-14: commenting is always available on a
// selection in the preview — a small "Comment" button next to it, or
// ⌥⌘M / Ctrl+Alt+M — and never in the source view. The comment goes into
// the file as CriticMarkup (see `markdown-comments.js`), signed with the name
// from *Settings › General*.
//
// This module owns what the reader sees and touches: the button at the
// selection, the form, the marker after each comment and the popover that
// shows it. Where in the file a selection lands, and writing the file, are
// asked of the view through `locate` and `save`.

import { t } from '../i18n.js';
import { normalizeSpace, occurrenceIndex, parseComment } from './markdown-comments.js';

const GAP_PX = 6;
const WORD_JOINER = '\u2060';
const EDGE_PX = 8;

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent ?? '');

const COMMENT_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

/** Where a selection may not be commented, and why — checked before anything is searched. */
const REFUSED_INSIDE = [
  ['pre, code', 'code'],
  ['.md-front-matter', 'frontMatter'],
];

/** The smallest element a comment has to stay inside: one line of a table, one item, one paragraph. */
const UNIT = 'p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, blockquote, figcaption';

/** True when the shortcut for a comment was pressed: ⌥⌘M on a Mac, Ctrl+Alt+M elsewhere. */
export function isCommentShortcut(event) {
  const primary = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return primary && event.altKey && !event.shiftKey && event.code === 'KeyM';
}

function shortcutLabel() {
  return isMac() ? '⌥⌘M' : 'Ctrl+Alt+M';
}

function elementOf(node) {
  return node?.nodeType === 1 ? node : node?.parentElement ?? null;
}

/**
 * @param {{
 *   previewEl: HTMLElement,
 *   articleEl: HTMLElement,
 *   canComment: () => boolean,
 *   isBlocked: () => boolean,
 *   getAuthor: () => Promise<string>,
 *   locate: (request: { blockRange: [number, number] | null, selected: string, occurrence: number }) => ({ target: object } | { error: string }),
 *   save: (target: object, text: string) => Promise<boolean>,
 *   notify: (message: string) => void,
 * }} options
 */
export function createCommentUi({ previewEl, articleEl, canComment, isBlocked, getAuthor, locate, save, notify }) {
  let disposed = false;
  let frame = 0;
  // The open form or comment: `{ kind: 'compose'|'view', el, returnFocus, … }`.
  let open = null;

  // ── The button at the selection ─────────────────────────────────────────

  const actionEl = document.createElement('button');
  actionEl.type = 'button';
  actionEl.className = 'md-comment-action';
  actionEl.hidden = true;
  actionEl.setAttribute('aria-haspopup', 'dialog');
  actionEl.setAttribute('aria-keyshortcuts', isMac() ? 'Meta+Alt+M' : 'Control+Alt+M');
  actionEl.innerHTML = COMMENT_ICON;
  const actionLabel = document.createElement('span');
  actionEl.append(actionLabel);
  // In the document only while it is on show: hidden, its label would still be
  // part of the preview's text.

  function applyLabels() {
    actionLabel.textContent = t('fileView.markdown.comment.action');
    actionEl.title = isBlocked()
      ? t('fileView.markdown.comment.blocked')
      : `${t('fileView.markdown.comment.action')} (${shortcutLabel()})`;
    for (const marker of articleEl.querySelectorAll('.md-comment-marker')) labelMarker(marker);
  }

  /** The selection, when it is a passage of this document — otherwise null. */
  function currentRange() {
    const selection = document.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!articleEl.contains(range.startContainer) || !articleEl.contains(range.endContainer)) return null;
    if (!normalizeSpace(range.toString())) return null;
    return range;
  }

  /** Where the selection ends, inside the scrolling preview. */
  function anchorOf(range) {
    const rects = typeof range.getClientRects === 'function'
      ? [...range.getClientRects()].filter((rect) => rect.width || rect.height)
      : [];
    const rect = rects.at(-1) ?? range.getBoundingClientRect?.() ?? { top: 0, bottom: 0, left: 0, right: 0 };
    const outer = previewEl.getBoundingClientRect();
    return {
      top: rect.top - outer.top + previewEl.scrollTop,
      bottom: rect.bottom - outer.top + previewEl.scrollTop,
      left: rect.left - outer.left + previewEl.scrollLeft,
      right: rect.right - outer.left + previewEl.scrollLeft,
    };
  }

  /** Below the anchor, kept inside the visible width of the preview. */
  function placeBelow(el, anchor, { alignRight = false } = {}) {
    const width = el.offsetWidth;
    const minLeft = previewEl.scrollLeft + EDGE_PX;
    const maxLeft = previewEl.scrollLeft + previewEl.clientWidth - width - EDGE_PX;
    const wanted = alignRight ? anchor.right - width : anchor.left;
    el.style.left = `${Math.max(minLeft, Math.min(wanted, maxLeft))}px`;
    el.style.top = `${anchor.bottom + GAP_PX}px`;
  }

  function updateAction() {
    frame = 0;
    if (disposed) return;
    const range = !open && !previewEl.hidden && canComment() ? currentRange() : null;
    if (!range) {
      hideAction();
      return;
    }
    if (!actionEl.isConnected) previewEl.append(actionEl);
    actionEl.hidden = false;
    actionEl.disabled = isBlocked();
    applyLabels();
    placeBelow(actionEl, anchorOf(range), { alignRight: true });
  }

  function hideAction() {
    actionEl.hidden = true;
    // Not while it has the focus: a keyboard user who tabbed to it keeps it.
    if (document.activeElement !== actionEl) actionEl.remove();
  }

  function scheduleUpdate() {
    if (frame || disposed) return;
    frame = requestAnimationFrame(updateAction);
  }

  // A click on the button must not take the selection away first.
  actionEl.addEventListener('mousedown', (event) => event.preventDefault());
  actionEl.addEventListener('click', () => {
    const range = currentRange();
    if (range) compose(range, { returnFocus: previewEl }).catch((err) => console.error('Comment form failed:', err));
  });

  document.addEventListener('selectionchange', scheduleUpdate);

  // ── Tracing a selection back ────────────────────────────────────────────

  /** `{ target }` for `save`, or `{ error }` — a key under fileView.markdown.comment.error. */
  function resolve(range) {
    const start = elementOf(range.startContainer);
    const end = elementOf(range.endContainer);
    for (const [selector, reason] of REFUSED_INSIDE) {
      if (start?.closest(selector) || end?.closest(selector)) return { error: reason };
    }
    const unit = start?.closest(UNIT);
    if (!unit || unit !== end?.closest(UNIT) || !articleEl.contains(unit)) return { error: 'span' };

    const block = unit.closest('[data-md-range]');
    const container = block && articleEl.contains(block) ? block : articleEl;
    const blockRange = container === articleEl
      ? null
      : container.getAttribute('data-md-range').split(':').map(Number);
    const selected = normalizeSpace(range.toString());
    const before = document.createRange();
    before.setStart(container, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const offsetBefore = before.toString().replace(/\u2060/g, '').replace(/\s+/g, ' ').trimStart().length;
    const occurrence = occurrenceIndex(normalizeSpace(container.textContent), selected, offsetBefore);
    return locate({ blockRange, selected, occurrence });
  }

  // ── The form ────────────────────────────────────────────────────────────

  function closeOpen({ focus = true } = {}) {
    if (!open) return;
    const { el, returnFocus, marker } = open;
    const hadFocus = el.contains(document.activeElement);
    open = null;
    el.remove();
    marker?.setAttribute('aria-expanded', 'false');
    if ((focus || hadFocus) && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    scheduleUpdate();
  }

  function popoverShell(kind, label) {
    const el = document.createElement(kind === 'compose' ? 'form' : 'div');
    el.className = `md-comment-popover md-comment-popover--${kind}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', label);
    el.tabIndex = -1;
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeOpen({ focus: true });
    });
    return el;
  }

  async function compose(range, { returnFocus }) {
    if (isBlocked()) {
      notify(t('fileView.markdown.comment.blocked'));
      return;
    }
    const located = resolve(range);
    if (located.error) {
      notify(t(`fileView.markdown.comment.error.${located.error}`));
      return;
    }
    closeOpen({ focus: false });
    const anchor = anchorOf(range);

    const form = popoverShell('compose', t('fileView.markdown.comment.title'));
    const quote = document.createElement('p');
    quote.className = 'md-comment-popover__quote';
    quote.textContent = normalizeSpace(range.toString());
    const fieldId = `md-comment-input-${Date.now()}`;
    const label = document.createElement('label');
    label.className = 'visually-hidden';
    label.htmlFor = fieldId;
    label.textContent = t('fileView.markdown.comment.title');
    const input = document.createElement('textarea');
    input.id = fieldId;
    input.className = 'modal-input md-comment-popover__input';
    input.rows = 3;
    input.placeholder = t('fileView.markdown.comment.placeholder');
    const author = document.createElement('p');
    author.className = 'md-comment-popover__author';
    const actions = document.createElement('div');
    actions.className = 'md-comment-popover__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = t('fileView.markdown.comment.cancel');
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn-primary';
    submit.textContent = t('fileView.markdown.comment.submit');
    submit.disabled = true;
    submit.setAttribute('aria-keyshortcuts', isMac() ? 'Meta+Enter' : 'Control+Enter');
    actions.append(cancel, submit);
    form.append(quote, label, input, author, actions);

    let saving = false;
    const update = () => {
      submit.disabled = saving || !input.value.trim();
      cancel.disabled = saving;
      input.readOnly = saving;
    };
    input.addEventListener('input', update);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !submit.disabled) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    cancel.addEventListener('click', () => closeOpen({ focus: true }));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving || !input.value.trim()) return;
      if (isBlocked()) {
        notify(t('fileView.markdown.comment.blocked'));
        return;
      }
      saving = true;
      update();
      const ok = await save(located.target, input.value);
      if (disposed || open?.el !== form) return;
      saving = false;
      update();
      if (ok) {
        document.getSelection?.()?.removeAllRanges();
        closeOpen({ focus: true });
      }
    });

    open = { kind: 'compose', el: form, returnFocus };
    previewEl.append(form);
    placeBelow(form, anchor);
    hideAction();
    input.focus({ preventScroll: true });
    form.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });

    const name = await getAuthor().catch(() => {
      // Unreadable prefs show the line for "no name" instead of none at all.
      return '';
    });
    if (disposed || open?.el !== form) return;
    author.textContent = name
      ? t('fileView.markdown.comment.as', { name })
      : t('fileView.markdown.comment.noAuthor');
  }

  // ── The comments already there ──────────────────────────────────────────

  // Each marker and the highlight it belongs to. The marker stands right
  // after the highlight — or after the link around it, since a button inside
  // a link would be one control inside another.
  const markOfMarker = new WeakMap();
  const markerOfMark = new WeakMap();

  function commentOf(marker) {
    return parseComment(markOfMarker.get(marker)?.getAttribute('data-md-comment') ?? '');
  }

  function labelMarker(marker) {
    const { author } = commentOf(marker);
    const label = author
      ? t('fileView.markdown.comment.open', { author })
      : t('fileView.markdown.comment.openNoAuthor');
    marker.setAttribute('aria-label', label);
    marker.title = label;
  }

  function show(marker) {
    if (open?.marker === marker) {
      closeOpen({ focus: true });
      return;
    }
    closeOpen({ focus: false });
    const comment = commentOf(marker);
    const el = popoverShell('view', marker.getAttribute('aria-label'));
    const head = document.createElement('header');
    head.className = 'md-comment-popover__head';
    const name = document.createElement('strong');
    name.className = 'md-comment-popover__name';
    name.textContent = comment.author || t('fileView.markdown.comment.unknownAuthor');
    head.append(name);
    if (comment.date) {
      const time = document.createElement('time');
      time.className = 'md-comment-popover__date';
      time.dateTime = comment.date;
      time.textContent = comment.date;
      head.append(time);
    }
    const text = document.createElement('p');
    text.className = 'md-comment-popover__text';
    text.textContent = comment.text;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'md-comment-popover__close';
    close.setAttribute('aria-label', t('fileView.markdown.comment.close'));
    close.title = close.getAttribute('aria-label');
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => closeOpen({ focus: true }));
    el.append(close, head, text);

    open = { kind: 'view', el, returnFocus: marker, marker };
    marker.setAttribute('aria-expanded', 'true');
    previewEl.append(el);
    const outer = previewEl.getBoundingClientRect();
    const rect = marker.getBoundingClientRect();
    placeBelow(el, {
      top: rect.top - outer.top + previewEl.scrollTop,
      bottom: rect.bottom - outer.top + previewEl.scrollTop,
      left: rect.left - outer.left + previewEl.scrollLeft,
      right: rect.right - outer.left + previewEl.scrollLeft,
    });
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * After every render: a button after each comment, so that it can be
   * reached and opened with the keyboard. A click on the highlight opens it
   * as well.
   */
  function decorate() {
    if (open && !previewEl.contains(open.returnFocus)) closeOpen({ focus: false });
    for (const mark of articleEl.querySelectorAll('mark.md-comment[data-md-comment]')) {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'md-comment-marker';
      marker.setAttribute('aria-haspopup', 'dialog');
      marker.setAttribute('aria-expanded', 'false');
      marker.innerHTML = COMMENT_ICON;
      // A word joiner keeps the marker on the line of the passage's last word.
      (mark.closest('a') ?? mark).after(WORD_JOINER, marker);
      markOfMarker.set(marker, mark);
      markerOfMark.set(mark, marker);
      labelMarker(marker);
    }
    scheduleUpdate();
  }

  function onClick(event) {
    const marker = event.target.closest?.('.md-comment-marker');
    if (marker && articleEl.contains(marker)) {
      event.preventDefault();
      show(marker);
      return;
    }
    const mark = event.target.closest?.('mark.md-comment[data-md-comment]');
    if (!mark || !articleEl.contains(mark)) return;
    // A click that ends a selection is a selection, not a request to open.
    if (currentRange()) return;
    // Inside a link, the link has the click.
    if (mark.closest('a')) return;
    const ownMarker = markerOfMark.get(mark);
    if (ownMarker) show(ownMarker);
  }

  function onPointerDown(event) {
    if (!open || open.el.contains(event.target)) return;
    if (open.kind === 'view' && open.marker.contains(event.target)) return;
    // A form with text in it is not thrown away by a stray click.
    if (open.kind === 'compose' && open.el.querySelector('textarea')?.value.trim()) return;
    closeOpen({ focus: false });
  }

  articleEl.addEventListener('click', onClick);
  document.addEventListener('pointerdown', onPointerDown, true);
  previewEl.addEventListener('scroll', scheduleUpdate, { passive: true });

  applyLabels();

  return {
    decorate,
    applyLabels,
    /** The shortcut: comment the current selection, if there is one here. */
    composeFromSelection() {
      const range = currentRange();
      if (!range) return false;
      if (!canComment()) return false;
      compose(range, { returnFocus: previewEl }).catch((err) => console.error('Comment form failed:', err));
      return true;
    },
    /** The preview went out of sight, or the lock moved. */
    refresh() {
      if (previewEl.hidden) closeOpen({ focus: false });
      scheduleUpdate();
    },
    /** For tests and the view: whether a form or a comment is open. */
    get openKind() {
      return open?.kind ?? null;
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', scheduleUpdate);
      document.removeEventListener('pointerdown', onPointerDown, true);
      articleEl.removeEventListener('click', onClick);
      previewEl.removeEventListener('scroll', scheduleUpdate);
      closeOpen({ focus: false });
      actionEl.remove();
    },
  };
}
