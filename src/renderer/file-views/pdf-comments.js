// Comments in the PDF view (#1299): what a reviewer wrote behind a highlight
// or a sticky note, opened by a click on the marking.
//
// pdf.js draws the markings into the canvas; their text it only hands out
// through `page.getAnnotations()`. pdf.js's own annotation layer is not used
// — it would also make links and form fields live, which the view keeps inert
// on purpose (see `pdf-engine.js`). Instead every marking that carries a
// comment gets a transparent button of our own over it, and the comment opens
// in a popover of our own. Everything from the PDF goes in as `textContent`:
// a formatted comment (`richText`) is shown by its plain text, nothing from
// the file is ever parsed as HTML.
//
// Replies (`/IRT`) are listed under the comment they answer and get no button
// of their own; members of a group (`/RT /Group`) share their parent's
// comment and are left out.

import { t, tPlural, getLocale } from '../i18n.js';

// What never opens a comment: links and form fields stay inert, a popup is
// only the window of its parent, and a text box shows its text on the page.
const SKIPPED = new Set(['Link', 'Widget', 'Popup', 'FreeText']);
// /F bits: Invisible, Hidden, NoView.
const HIDDEN_FLAGS = 1 | 2 | 32;
// A sticky note is a small icon; the button is never smaller than the
// touch target of ui-design-tokens.md.
const MIN_TARGET_PX = 32;
const POPOVER_GAP_PX = 6;

const textOf = (obj) => (typeof obj?.str === 'string' ? obj.str.trim() : '');
const dirOf = (obj) => (obj?.dir === 'rtl' ? 'rtl' : 'ltr');

/**
 * A PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`, everything after the year optional)
 * as a Date, or null.
 */
export function parsePdfDate(value) {
  if (typeof value !== 'string') return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(value);
  if (!m) return null;
  const n = (s, fallback) => (s === undefined ? fallback : Number.parseInt(s, 10));
  let minutes = 0;
  if (m[7] === '+' || m[7] === '-') {
    minutes = (n(m[8], 0) * 60 + n(m[9], 0)) * (m[7] === '+' ? -1 : 1);
  }
  const date = new Date(Date.UTC(n(m[1]), n(m[2], 1) - 1, n(m[3], 1), n(m[4], 0), n(m[5], 0) + minutes, n(m[6], 0)));
  return Number.isFinite(date.getTime()) ? date : null;
}

function entryOf(annotation) {
  return {
    author: textOf(annotation.titleObj),
    authorDir: dirOf(annotation.titleObj),
    text: textOf(annotation.contentsObj),
    textDir: dirOf(annotation.contentsObj),
    date: parsePdfDate(annotation.modificationDate) ?? parsePdfDate(annotation.creationDate),
  };
}

/**
 * The comments on a page, from what `page.getAnnotations()` returned: one
 * entry per marking that has something to say, with its replies in order.
 */
export function commentsFromAnnotations(annotations) {
  if (!Array.isArray(annotations)) return [];
  const byId = new Map();
  const roots = [];
  const replies = [];
  for (const a of annotations) {
    if (!a || SKIPPED.has(a.subtype)) continue;
    if (a.inReplyTo) {
      if (a.replyType !== 'Group') replies.push(a);
      continue;
    }
    if (!Array.isArray(a.rect) || a.rect.length !== 4) continue;
    if ((a.annotationFlags ?? 0) & HIDDEN_FLAGS) continue;
    const comment = { id: String(a.id ?? roots.length), rect: a.rect, ...entryOf(a), replies: [] };
    if (a.id != null) byId.set(String(a.id), comment);
    roots.push(comment);
  }
  for (const reply of replies) {
    const parent = byId.get(String(reply.inReplyTo));
    const entry = entryOf(reply);
    if (parent && entry.text) parent.replies.push(entry);
  }
  for (const comment of roots) {
    comment.replies.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  }
  return roots.filter((c) => c.text || c.replies.length);
}

/**
 * Where a comment's button sits on the page, in CSS pixels from the page's
 * top left. `viewport` is pdf.js's viewport at CSS scale.
 */
export function placeOf(rect, viewport) {
  // Two corners: pdf.js 6 has no rectangle conversion any more.
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  let left = Math.min(x1, x2);
  let top = Math.min(y1, y2);
  let width = Math.abs(x2 - x1);
  let height = Math.abs(y2 - y1);
  if (width < MIN_TARGET_PX) {
    left -= (MIN_TARGET_PX - width) / 2;
    width = MIN_TARGET_PX;
  }
  if (height < MIN_TARGET_PX) {
    top -= (MIN_TARGET_PX - height) / 2;
    height = MIN_TARGET_PX;
  }
  return { left, top, width, height };
}

function formatDate(date) {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    // A locale Intl does not know: the date in ISO form still says it.
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function authorName(entry) {
  return entry.author || t('fileView.pdf.comment.unknownAuthor');
}

function buttonLabel(comment) {
  const base = t('fileView.pdf.comment.open', { author: authorName(comment) });
  return comment.replies.length
    ? `${base}, ${tPlural('fileView.pdf.comment.replies', comment.replies.length, { count: comment.replies.length })}`
    : base;
}

function entryNode(entry, className) {
  const item = document.createElement('article');
  item.className = className;
  const head = document.createElement('header');
  head.className = 'pdf-comment__head';
  const author = document.createElement('strong');
  author.className = 'pdf-comment__author';
  author.dir = entry.author ? entry.authorDir : 'auto';
  author.textContent = authorName(entry);
  head.append(author);
  if (entry.date) {
    const time = document.createElement('time');
    time.className = 'pdf-comment__date';
    time.dateTime = entry.date.toISOString();
    time.textContent = formatDate(entry.date);
    head.append(time);
  }
  const text = document.createElement('p');
  text.className = 'pdf-comment__text';
  text.dir = entry.textDir;
  text.textContent = entry.text;
  item.append(head);
  if (entry.text) item.append(text);
  return item;
}

/**
 * The buttons over the markings and the one popover. `viewEl` is the
 * scrolling view; the popover is placed inside the page it belongs to and
 * kept within the view's visible width.
 */
export function createCommentLayer({ viewEl }) {
  // Page number → { layerEl, comments, buttons }
  const pages = new Map();
  let open = null; // { page, id, button, popover }

  function attach(pageEl, n, comments, viewport) {
    detach(n);
    if (!comments.length) return;
    const layerEl = document.createElement('div');
    layerEl.className = 'pdf-comments';
    const buttons = new Map();
    for (const comment of comments) {
      const place = placeOf(comment.rect, viewport);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pdf-comment-target';
      button.style.left = `${place.left}px`;
      button.style.top = `${place.top}px`;
      button.style.width = `${place.width}px`;
      button.style.height = `${place.height}px`;
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-label', buttonLabel(comment));
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && open?.button === button) {
          event.preventDefault();
          event.stopPropagation();
          close({ focus: false });
        }
      });
      button.addEventListener('click', () => {
        if (open?.page === n && open.id === comment.id) close({ focus: false });
        else show(n, comment, button);
      });
      buttons.set(comment.id, button);
      layerEl.append(button);
    }
    pageEl.append(layerEl);
    pages.set(n, { layerEl, comments, buttons });
  }

  function detach(n) {
    const entry = pages.get(n);
    if (!entry) return;
    if (open?.page === n) close({ focus: false });
    entry.layerEl.remove();
    pages.delete(n);
  }

  function show(n, comment, button, { focus = true } = {}) {
    close({ focus: false });
    const layerEl = pages.get(n)?.layerEl;
    if (!layerEl) return;
    const popover = document.createElement('div');
    popover.className = 'pdf-comment';
    popover.setAttribute('role', 'dialog');
    popover.tabIndex = -1;
    popover.setAttribute('aria-label', t('fileView.pdf.comment.title', { author: authorName(comment) }));
    popover.append(entryNode(comment, 'pdf-comment__entry'));
    if (comment.replies.length) {
      const list = document.createElement('ol');
      list.className = 'pdf-comment__replies';
      list.setAttribute('aria-label', tPlural('fileView.pdf.comment.replies', comment.replies.length, { count: comment.replies.length }));
      for (const reply of comment.replies) {
        const li = document.createElement('li');
        li.append(entryNode(reply, 'pdf-comment__entry pdf-comment__entry--reply'));
        list.append(li);
      }
      popover.append(list);
    }
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'pdf-comment__close';
    closeButton.setAttribute('aria-label', t('fileView.pdf.comment.close'));
    closeButton.title = closeButton.getAttribute('aria-label');
    closeButton.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    closeButton.addEventListener('click', () => close({ focus: true }));
    popover.prepend(closeButton);
    popover.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close({ focus: true });
      }
    });
    layerEl.append(popover);
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('pdf-comment-target--open');
    open = { page: n, id: comment.id, button, popover };
    place(popover, button);
    if (!focus) return;
    popover.focus({ preventScroll: true });
    // Into view, if it opened past the edge of what is visible.
    popover.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  /** Below the marking, or above it when the page ends first; inside the view's width. */
  function place(popover, button) {
    const pageEl = popover.closest('.pdf-page');
    const pageWidth = pageEl?.offsetWidth || 0;
    const pageHeight = pageEl?.offsetHeight || 0;
    const left = button.offsetLeft;
    const top = button.offsetTop;
    const below = top + button.offsetHeight + POPOVER_GAP_PX;
    const height = popover.offsetHeight;
    popover.style.top = `${height && below + height > pageHeight && top - POPOVER_GAP_PX - height >= 0 ? top - POPOVER_GAP_PX - height : below}px`;
    // Horizontally: start at the marking, but stay on the visible part of
    // the page — a page wider than the column scrolls sideways.
    const width = popover.offsetWidth;
    const visibleLeft = Math.max(0, viewEl.scrollLeft - (pageEl?.offsetLeft ?? 0));
    const visibleRight = Math.min(pageWidth || Infinity, visibleLeft + (viewEl.clientWidth || Infinity));
    let x = left;
    if (width && x + width > visibleRight) x = visibleRight - width;
    popover.style.left = `${Math.max(visibleLeft, x)}px`;
  }

  function close({ focus }) {
    if (!open) return;
    const { button, popover } = open;
    open = null;
    const hadFocus = popover.contains(document.activeElement);
    popover.remove();
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('pdf-comment-target--open');
    if ((focus || hadFocus) && button.isConnected) button.focus({ preventScroll: true });
  }

  function onPointerDown(event) {
    if (!open) return;
    if (open.popover.contains(event.target) || open.button.contains(event.target)) return;
    close({ focus: false });
  }
  function onFocusIn(event) {
    if (!open) return;
    if (open.popover.contains(event.target) || open.button === event.target) return;
    close({ focus: false });
  }
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('focusin', onFocusIn);

  function relabel() {
    for (const { comments, buttons } of pages.values()) {
      for (const comment of comments) buttons.get(comment.id)?.setAttribute('aria-label', buttonLabel(comment));
    }
    if (open) {
      const { page, id, button } = open;
      const comment = pages.get(page)?.comments.find((c) => c.id === id);
      // Drawn again in the new language; the focus stays where it is.
      const hadFocus = open.popover.contains(document.activeElement);
      if (comment) show(page, comment, button, { focus: hadFocus });
    }
  }

  return {
    attach,
    detach,
    close,
    relabel,
    clear() {
      for (const n of [...pages.keys()]) detach(n);
    },
    dispose() {
      this.clear();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
    },
    /** For tests. */
    get openComment() {
      return open ? { page: open.page, id: open.id } : null;
    },
  };
}
