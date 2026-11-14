// Adding a comment in the PDF view (#1386): select text, write a note, and
// it lands in the file as a standard highlight annotation that Acrobat,
// Preview and the comment layer of this view (`pdf-comments.js`) all show.
//
// Three parts, from the pure to the interactive:
//
// - **Geometry.** What the browser selected comes as client rectangles over
//   the text layer. They are taken on one page — the first the selection
//   touches — turned into PDF user space, merged line by line, and become the
//   highlight's `QuadPoints`, its appearance outlines and its `Rect`. Merging
//   happens in PDF space, where text runs horizontally even on a page that is
//   shown rotated.
// - **The annotation.** A plain object in the shape pdf.js's highlight editor
//   serialises to. pdf.js writes it as an incremental update
//   (`pdf-engine.js`), so the bytes that were there stay as they were.
// - **The composer.** A "Comment" chip next to the selection and a popover
//   with a text field. Both live in a layer of the scrolling view rather than
//   in a page: a page is rebuilt on every zoom and every reload, and what the
//   user typed must survive both. The marked passage is kept in PDF
//   coordinates and drawn again wherever the page now sits.

import contracts from '../generated/contracts.js';
import { t } from '../i18n.js';

const { MAX_PDF_COMMENT_CHARS } = contracts;

/** The yellow of pdf.js's own highlighter, multiplied onto the page. */
export const HIGHLIGHT_COLOR = Object.freeze([255, 255, 152]);
const GAP_PX = 6;
// A rectangle larger than this share of the page is a whole layer the range
// swallowed, not a run of text.
const MAX_RECT_SHARE = 0.5;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

/**
 * The selection's rectangles on one page, as boxes in PDF user space
 * (`{ x1, y1, x2, y2 }`, y up), merged into one box per run of a line.
 *
 * @param {Iterable<{ left: number, top: number, right: number, bottom: number, width: number, height: number }>} clientRects
 * @param {{ left: number, top: number, width: number, height: number }} pageRect  the page's client rectangle
 * @param {{ convertToPdfPoint(x: number, y: number): number[] }} viewport  at the page's current CSS scale
 */
export function selectionBoxes(clientRects, pageRect, viewport) {
  const pageArea = pageRect.width * pageRect.height;
  const boxes = [];
  for (const r of clientRects) {
    const left = Math.max(r.left, pageRect.left);
    const right = Math.min(r.right, pageRect.left + pageRect.width);
    const top = Math.max(r.top, pageRect.top);
    const bottom = Math.min(r.bottom, pageRect.top + pageRect.height);
    if (right - left < 1 || bottom - top < 1) continue;
    if ((right - left) * (bottom - top) > pageArea * MAX_RECT_SHARE) continue;
    const [ax, ay] = viewport.convertToPdfPoint(left - pageRect.left, top - pageRect.top);
    const [bx, by] = viewport.convertToPdfPoint(right - pageRect.left, bottom - pageRect.top);
    boxes.push({ x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) });
  }
  return mergeLines(boxes);
}

/**
 * One box per run of text on a line: boxes that share most of their height
 * are one line, and within a line boxes closer than a line's height are one
 * run. Two columns side by side stay two boxes.
 */
export function mergeLines(boxes) {
  const sorted = [...boxes].sort((a, b) => (b.y2 - a.y2) || (a.x1 - b.x1));
  const lines = [];
  for (const box of sorted) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.y2, box.y2) - Math.max(l.y1, box.y1);
      return overlap > 0.5 * Math.min(l.y2 - l.y1, box.y2 - box.y1);
    });
    if (line) {
      line.boxes.push(box);
      line.y1 = Math.min(line.y1, box.y1);
      line.y2 = Math.max(line.y2, box.y2);
    } else {
      lines.push({ y1: box.y1, y2: box.y2, boxes: [box] });
    }
  }
  const merged = [];
  for (const line of lines.sort((a, b) => b.y2 - a.y2)) {
    const runs = [];
    for (const box of line.boxes.sort((a, b) => a.x1 - b.x1)) {
      const last = runs.at(-1);
      if (last && box.x1 - last.x2 <= Math.max(last.y2 - last.y1, box.y2 - box.y1)) {
        last.x2 = Math.max(last.x2, box.x2);
        last.y1 = Math.min(last.y1, box.y1);
        last.y2 = Math.max(last.y2, box.y2);
      } else {
        runs.push({ ...box });
      }
    }
    merged.push(...runs);
  }
  return merged;
}

/**
 * The highlight annotation for pdf.js to write: what its highlight editor
 * serialises, with the comment in `popup.contents`. `boxes` from
 * `selectionBoxes`, `date` a Date.
 */
export function highlightAnnotation({ pageIndex, boxes, text, author, date }) {
  const quadPoints = [];
  const outlines = [];
  for (const { x1, y1, x2, y2 } of boxes) {
    // Upper left, upper right, lower left, lower right — the order every
    // reader expects, the PDF spec's drawing notwithstanding.
    quadPoints.push(x1, y2, x2, y2, x1, y1, x2, y1);
    outlines.push([x1, y1, x1, y2, x2, y2, x2, y1]);
  }
  const rect = [
    Math.min(...boxes.map((b) => b.x1)),
    Math.min(...boxes.map((b) => b.y1)),
    Math.max(...boxes.map((b) => b.x2)),
    Math.max(...boxes.map((b) => b.y2)),
  ];
  return {
    pageIndex,
    rect,
    quadPoints,
    outlines,
    color: [...HIGHLIGHT_COLOR],
    opacity: 1,
    user: author || undefined,
    date,
    popup: {
      contents: text,
      // Where a reader puts the note when it is opened: beside the marking.
      rect: [rect[2], rect[3] - 120, rect[2] + 200, rect[3]],
    },
  };
}

/** The page a selection starts on, and its rectangles there; null if it is not in the text of a page. */
function selectionOnPage(viewEl) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!viewEl.contains(range.commonAncestorContainer)) return null;
  const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const layer = startEl?.closest?.('.pdf-text-layer');
  const pageEl = layer?.closest('.pdf-page');
  if (!pageEl || !String(selection).trim()) return null;
  return { pageEl, page: Number(pageEl.dataset.page), rects: [...range.getClientRects()] };
}

/**
 * The chip and the popover. `pageGeometry(n)` answers `{ el, viewport }`
 * for a drawn page at the current zoom, or null; `save({ page, boxes, text })`
 * writes the comment and answers `{ ok }` or `{ ok: false, reason }`;
 * `blockedReason()` is null or the reason the document takes no comments;
 * `author()` the name it is signed with.
 */
export function createCommentComposer({ viewEl, pageGeometry, save, blockedReason, author, announce }) {
  const layerEl = document.createElement('div');
  layerEl.className = 'pdf-compose-layer';
  viewEl.append(layerEl);

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'pdf-compose-chip';
  chip.hidden = true;
  chip.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const chipLabel = document.createElement('span');
  chip.append(chipLabel);
  layerEl.append(chip);
  // pointerdown would move the focus and with it drop the selection.
  chip.addEventListener('pointerdown', (event) => event.preventDefault());
  chip.addEventListener('click', () => openFromSelection());

  let selected = null; // { page, boxes } for the chip
  let draft = null; // { page, boxes, el, marks, field, … } while the popover is open
  let selectionTimer = 0;

  function shortcutText() {
    return isMac ? '⌘⌥M' : 'Ctrl+Alt+M';
  }

  function labelChip() {
    chipLabel.textContent = t('fileView.pdf.annotate.chip');
    chip.title = `${t('fileView.pdf.annotate.chipTitle')} (${shortcutText()})`;
    chip.setAttribute('aria-keyshortcuts', isMac ? 'Meta+Alt+M' : 'Control+Alt+M');
  }
  labelChip();

  /** Where a page sits in the view's scrolled content. */
  function pageOffset(pageEl) {
    const view = viewEl.getBoundingClientRect();
    const page = pageEl.getBoundingClientRect();
    return {
      x: page.left - view.left - viewEl.clientLeft + viewEl.scrollLeft,
      y: page.top - view.top - viewEl.clientTop + viewEl.scrollTop,
    };
  }

  /** The boxes as CSS rectangles in the view's content, or null while the page is not drawn. */
  function placeBoxes(page, boxes) {
    const geometry = pageGeometry(page);
    if (!geometry) return null;
    const offset = pageOffset(geometry.el);
    return boxes.map(({ x1, y1, x2, y2 }) => {
      const [ax, ay] = geometry.viewport.convertToViewportPoint(x1, y1);
      const [bx, by] = geometry.viewport.convertToViewportPoint(x2, y2);
      return {
        left: offset.x + Math.min(ax, bx),
        top: offset.y + Math.min(ay, by),
        width: Math.abs(bx - ax),
        height: Math.abs(by - ay),
        pageLeft: offset.x,
        pageWidth: geometry.el.offsetWidth,
      };
    });
  }

  // ── The chip ────────────────────────────────────────────────────────────

  function readSelection() {
    const found = selectionOnPage(viewEl);
    if (!found) return null;
    const geometry = pageGeometry(found.page);
    if (!geometry) return null;
    const boxes = selectionBoxes(found.rects, geometry.el.getBoundingClientRect(), geometry.viewport);
    return boxes.length ? { page: found.page, boxes } : null;
  }

  function updateChip() {
    selectionTimer = 0;
    selected = draft ? null : readSelection();
    if (!selected) {
      chip.hidden = true;
      return;
    }
    const placed = placeBoxes(selected.page, selected.boxes);
    if (!placed) {
      chip.hidden = true;
      return;
    }
    const last = placed.at(-1);
    chip.hidden = false;
    const width = chip.offsetWidth;
    const right = last.left + last.width;
    chip.style.left = `${Math.max(last.pageLeft, Math.min(right - width, last.pageLeft + last.pageWidth - width))}px`;
    chip.style.top = `${last.top + last.height + GAP_PX}px`;
  }

  function onSelectionChange() {
    if (draft) return;
    // A drag reports every character; the chip waits until it settles.
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(updateChip, 120);
  }
  document.addEventListener('selectionchange', onSelectionChange);

  // ── The popover ─────────────────────────────────────────────────────────

  function openFromSelection() {
    const found = draft ? null : readSelection();
    if (!found) return false;
    document.getSelection()?.removeAllRanges();
    chip.hidden = true;
    selected = null;
    openDraft(found);
    return true;
  }

  function openDraft({ page, boxes }) {
    const el = document.createElement('div');
    el.className = 'pdf-compose';
    el.setAttribute('role', 'dialog');
    const titleId = `pdf-compose-title-${Date.now()}`;
    el.setAttribute('aria-labelledby', titleId);

    const head = document.createElement('header');
    head.className = 'pdf-compose__head';
    const title = document.createElement('strong');
    title.className = 'pdf-compose__title';
    title.id = titleId;
    const byline = document.createElement('span');
    byline.className = 'pdf-compose__author';
    head.append(title, byline);

    const body = document.createElement('div');
    body.className = 'pdf-compose__body';
    const message = document.createElement('p');
    message.className = 'pdf-compose__message';
    message.setAttribute('role', 'alert');
    message.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'pdf-compose__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary pdf-compose__cancel';
    cancel.addEventListener('click', () => close({ focus: true }));

    const blocked = blockedReason();
    let field = null;
    let submit = null;
    if (blocked) {
      const note = document.createElement('p');
      note.className = 'pdf-compose__note';
      body.append(note);
      actions.append(cancel);
    } else {
      field = document.createElement('textarea');
      field.className = 'modal-input pdf-compose__field';
      field.rows = 4;
      field.maxLength = MAX_PDF_COMMENT_CHARS;
      submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'btn-primary pdf-compose__save';
      submit.disabled = true;
      field.addEventListener('input', () => {
        if (!draft?.saving) submit.disabled = !field.value.trim();
      });
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          commit().catch(reportCommit);
        }
      });
      submit.addEventListener('click', () => commit().catch(reportCommit));
      body.append(field);
      actions.append(cancel, submit);
    }
    body.append(message);
    el.append(head, body, actions);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close({ focus: true });
      }
    });

    layerEl.append(el);
    draft = { page, boxes, el, title, byline, message, cancel, field, submit, blocked, marks: [], saving: false, error: null };
    relabel();
    relayout();
    author().then((name) => {
      if (draft?.el === el) {
        draft.authorName = name;
        labelByline();
      }
    }).catch(() => {
      // author() answers '' rather than failing; without a name the byline stays empty.
    });
    (field ?? cancel).focus({ preventScroll: true });
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function labelByline() {
    if (!draft) return;
    draft.byline.textContent = draft.authorName ? t('fileView.pdf.annotate.as', { author: draft.authorName }) : '';
    draft.byline.hidden = !draft.authorName || Boolean(draft.blocked);
  }

  /** Draws the marked passage and puts the popover under it, wherever the page now is. */
  function relayout() {
    if (!draft) {
      if (!chip.hidden) updateChip();
      return;
    }
    for (const mark of draft.marks) mark.remove();
    draft.marks = [];
    const placed = placeBoxes(draft.page, draft.boxes);
    if (!placed) {
      draft.el.hidden = true;
      return;
    }
    draft.el.hidden = false;
    for (const box of placed) {
      const mark = document.createElement('div');
      mark.className = 'pdf-compose-mark';
      mark.style.left = `${box.left}px`;
      mark.style.top = `${box.top}px`;
      mark.style.width = `${box.width}px`;
      mark.style.height = `${box.height}px`;
      layerEl.prepend(mark);
      draft.marks.push(mark);
    }
    const first = placed[0];
    const last = placed.at(-1);
    const width = draft.el.offsetWidth;
    const visibleLeft = Math.max(first.pageLeft, viewEl.scrollLeft);
    const visibleRight = Math.min(first.pageLeft + first.pageWidth, viewEl.scrollLeft + (viewEl.clientWidth || Infinity));
    let x = Math.min(...placed.map((b) => b.left));
    if (width && x + width > visibleRight) x = visibleRight - width;
    draft.el.style.left = `${Math.max(visibleLeft, x)}px`;
    draft.el.style.top = `${last.top + last.height + GAP_PX}px`;
  }

  /** What commit() did not catch itself — a bug, not a refusal. */
  function reportCommit(err) {
    console.warn('PDF comment composer:', err?.message ?? err);
  }

  function showError(reason) {
    if (!draft) return;
    draft.error = reason;
    const key = reason === 'changed' ? 'changed' : 'failed';
    draft.message.textContent = t(`fileView.pdf.annotate.error.${key}`);
    draft.message.hidden = false;
  }

  async function commit() {
    if (!draft || draft.saving || !draft.field) return;
    const text = draft.field.value.trim();
    if (!text) return;
    const current = draft;
    current.saving = true;
    current.submit.disabled = true;
    current.field.readOnly = true;
    current.message.hidden = true;
    current.submit.textContent = t('fileView.pdf.annotate.saving');
    let result;
    try {
      result = await save({ page: current.page, boxes: current.boxes, text });
    } catch (err) {
      console.warn('PDF comment could not be saved:', err?.message ?? err);
      result = { ok: false, reason: 'failed' };
    }
    if (draft !== current) return;
    current.saving = false;
    current.field.readOnly = false;
    current.submit.textContent = t('fileView.pdf.annotate.save');
    if (result?.ok) {
      close({ focus: true });
      announce(t('fileView.pdf.annotate.saved'));
      return;
    }
    current.submit.disabled = !current.field.value.trim();
    showError(result?.reason);
    current.field.focus({ preventScroll: true });
  }

  function close({ focus }) {
    if (!draft) return;
    const { el, marks } = draft;
    const hadFocus = el.contains(document.activeElement);
    draft = null;
    for (const mark of marks) mark.remove();
    el.remove();
    if ((focus || hadFocus) && viewEl.isConnected) viewEl.focus({ preventScroll: true });
  }

  function relabel() {
    labelChip();
    if (!draft) return;
    draft.title.textContent = t('fileView.pdf.annotate.title');
    draft.cancel.textContent = draft.blocked ? t('fileView.pdf.annotate.close') : t('fileView.pdf.annotate.cancel');
    if (draft.blocked) {
      draft.el.querySelector('.pdf-compose__note').textContent = t(`fileView.pdf.annotate.blocked.${draft.blocked}`);
    } else {
      draft.field.setAttribute('aria-label', t('fileView.pdf.annotate.field'));
      draft.field.placeholder = t('fileView.pdf.annotate.placeholder');
      draft.submit.textContent = draft.saving ? t('fileView.pdf.annotate.saving') : t('fileView.pdf.annotate.save');
    }
    if (draft.error) showError(draft.error);
    labelByline();
  }

  return {
    /** The shortcut: opens the popover for the selection, if there is one. */
    openFromSelection,
    relayout,
    relabel,
    /** Drops the chip; the popover and what is typed in it stay. */
    hideChip() {
      chip.hidden = true;
      selected = null;
    },
    close,
    dispose() {
      clearTimeout(selectionTimer);
      document.removeEventListener('selectionchange', onSelectionChange);
      close({ focus: false });
      layerEl.remove();
    },
    /** For tests. */
    get state() {
      return {
        chip: !chip.hidden,
        open: Boolean(draft),
        page: draft?.page ?? null,
        saving: Boolean(draft?.saving),
        error: draft?.error ?? null,
      };
    },
  };
}
