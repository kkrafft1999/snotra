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
// Decided on 2026-10-09 (#829): the preview zooms with the same "− 100 % +"
// group as the PDF and image previews, as a whole document — images and
// tables grow with the text — and at one size for every Markdown file.
//
// Since #863 the source can be edited: the plain-text view brings the Edit
// toggle and the save state, and this view puts them next to its own switch.
// What it saves becomes the text of the preview, rendered the next time the
// preview is on show; leaving the source saves first and stays when that
// fails.
//
// Since #1388 a passage selected in the preview can be commented: the comment
// goes into the file as CriticMarkup, through the same checked write as the
// source, and the preview shows it as a highlight with a marker. The parts
// are in `markdown-comments.js` (the source side) and
// `markdown-comment-ui.js` (what the reader sees).
//
// Since #1422 the preview itself can be edited: the same Edit toggle as the
// source's turns the rendered document into the editor, with a formatting
// toolbar below the header. Only the blocks the reader changes are written
// back; everything else in the file stays byte for byte. The parts are in
// `markdown-editing.js` (the document), `markdown-serialize.js` and
// `markdown-splice.js` (the way back into the file) and `markdown-toolbar.js`.
//
// The interface it implements is documented in the header of `registry.js`.

import contracts from '../generated/contracts.js';
import { APP_LOCALES, t, onLocaleChange } from '../i18n.js';
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
import { MARKDOWN_ZOOM_STEPS, markdownZoom, rememberMarkdownZoom } from './markdown-zoom.js';
import { ZOOM_IN_ICON, ZOOM_OUT_ICON, iconButton, nextZoom } from './zoom-tools.js';
import { plainTextView } from './plain-text-view.js';
import { SAVE_STATES, createAutosave, sha256Hex } from './autosave.js';
import { createEditControls } from './edit-controls.js';
import { FORMATS, attachEditing, canEditDocument } from './markdown-editing.js';
import { createFormatToolbar, matchFormatShortcut } from './markdown-toolbar.js';
import { COMMENT_ERRORS, commentDate, insertComment, insertReply, locateSelection, locateThread, removeThread } from './markdown-comments.js';
import { createCommentUi, isCommentShortcut } from './markdown-comment-ui.js';
import { commentAuthor as resolveCommentAuthor } from './comment-author.js';

const {
  isWorkspaceImageSource,
  workspaceImageDataUrl,
  workspaceImageErrorMessageKey,
  WORKSPACE_IMAGE_ERRORS,
} = contracts;

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);
const NOTICE_MS = 5000;
const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent ?? '');

/** A step of editing in the preview that failed outside a save (#1422); a save says so in its own bar. */
function warnEditFailure(err) {
  console.warn('Markdown preview: editing failed:', err?.message ?? err);
}
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
const LINK_DATA_ATTRIBUTES = ['data-link-kind', 'data-anchor', 'data-target', 'data-fragment', 'data-md-href', 'data-md-title'];
// Why a selection cannot be commented, as the key of its message (#1388).
const COMMENT_ERROR_KEYS = {
  [COMMENT_ERRORS.EMPTY]: 'notFound',
  [COMMENT_ERRORS.NOT_FOUND]: 'notFound',
  [COMMENT_ERRORS.AMBIGUOUS]: 'ambiguous',
  [COMMENT_ERRORS.OVERLAP]: 'overlap',
};

function buildFrontMatter(frontMatter) {
  const section = document.createElement('section');
  section.className = 'md-front-matter';
  const title = document.createElement('div');
  title.className = 'md-front-matter__title';
  title.textContent = t('fileView.markdown.frontMatter');
  // The term stays English in German too.
  title.lang = APP_LOCALES.EN;
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
  kind: 'editor',

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
    // The Edit toggle and save state of the source (#863).
    let sourceTools = [];
    // The source saved a text the preview has not rendered yet.
    let previewStale = false;
    // While a chat run is active nothing is written, comments included (#863).
    let editingBlocked = context.isEditingBlocked?.() === true;

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

    const modeSwitch = buildModeSwitch((next) => void requestMode(next));

    // ── Header tools: zoom (#829) ─────────────────────────────────────────

    const zoomEl = document.createElement('div');
    zoomEl.className = 'pdf-tools md-zoom';
    zoomEl.setAttribute('role', 'group');
    const zoomOutButton = iconButton('pdf-tools__zoom-out', ZOOM_OUT_ICON);
    const zoomValue = document.createElement('output');
    zoomValue.className = 'pdf-tools__zoom';
    zoomValue.setAttribute('aria-live', 'off');
    const zoomInButton = iconButton('pdf-tools__zoom-in', ZOOM_IN_ICON);
    zoomEl.append(zoomOutButton, zoomValue, zoomInButton);
    let zoom = markdownZoom();

    function applyToolLabels() {
      zoomEl.setAttribute('aria-label', t('fileView.markdown.zoom.label'));
      zoomOutButton.setAttribute('aria-label', t('fileView.markdown.zoom.out'));
      zoomOutButton.title = zoomOutButton.getAttribute('aria-label');
      zoomInButton.setAttribute('aria-label', t('fileView.markdown.zoom.in'));
      zoomInButton.title = zoomInButton.getAttribute('aria-label');
    }

    function renderZoomTools() {
      zoomValue.textContent = `${Math.round(zoom * 100)}\u00a0%`;
      zoomOutButton.disabled = zoom <= MARKDOWN_ZOOM_STEPS[0] + 0.001;
      zoomInButton.disabled = zoom >= MARKDOWN_ZOOM_STEPS.at(-1) - 0.001;
    }

    /**
     * Zooms the document and keeps the reader's place: the scroll position
     * moves by the share of the document it stood at, since the text wraps
     * anew and the height does not grow in proportion.
     */
    function applyZoom() {
      const before = previewEl.scrollHeight;
      const share = before > 0 ? previewEl.scrollTop / before : 0;
      articleEl.style.setProperty('--md-zoom', String(zoom));
      if (share > 0) previewEl.scrollTop = Math.round(share * previewEl.scrollHeight);
      fitTables();
      renderZoomTools();
    }

    function setZoom(next) {
      const applied = rememberMarkdownZoom(next, api);
      if (applied === zoom) return;
      zoom = applied;
      applyZoom();
    }

    /** The header: the switch, the Edit toggle and the zoom while the preview is on show. */
    function showTools() {
      const editTools = controls ? [controls.toggle, controls.status] : [];
      context.setTools(mode === MODES.PREVIEW ? [modeSwitch.element, ...editTools, zoomEl] : [modeSwitch.element, ...sourceTools]);
    }

    // ── Editing in the preview (#1422) ────────────────────────────────────

    const editable = context.editable !== false && typeof context.writeFile === 'function';
    // While the preview is edited: { doc, autosave, toolbar }.
    let edit = null;
    const controls = editable
      ? createEditControls({
        onToggle: () => {
          if (edit) leaveEditing({ focusToggle: true }).catch(warnEditFailure);
          else enterEditing();
        },
        onPrimary: () => onEditPrimary().catch(warnEditFailure),
        onSecondary: () => onEditSecondary().catch(warnEditFailure),
      })
      : null;

    zoomOutButton.addEventListener('click', () => setZoom(nextZoom(zoom, -1, MARKDOWN_ZOOM_STEPS)));
    zoomInButton.addEventListener('click', () => setZoom(nextZoom(zoom, 1, MARKDOWN_ZOOM_STEPS)));

    applyToolLabels();
    applyZoom();
    showTools();

    function showNotice(message) {
      clearTimeout(noticeTimer);
      noticeEl.textContent = message;
      noticeEl.hidden = false;
      noticeTimer = setTimeout(() => {
        noticeEl.hidden = true;
        noticeEl.textContent = '';
      }, NOTICE_MS);
    }

    // ── Comments (#1388) ──────────────────────────────────────────────────

    /** The setting, else the account name — the same name as a PDF comment's (#1391). */
    function commentAuthor() {
      return resolveCommentAuthor(api);
    }

    /** A selection in the preview, traced back to a place in `content`. */
    function locateComment({ blockRange, selected, occurrence }) {
      const { body } = splitDocument(content);
      if (!content.endsWith(body)) return { error: 'notFound' };
      const bodyOffset = content.length - body.length;
      const [from, to] = blockRange ?? [0, body.length];
      const located = locateSelection({ blockSource: body.slice(from, to), selected, occurrence, body });
      if (located.error) return { error: COMMENT_ERROR_KEYS[located.error] ?? 'notFound' };
      return {
        target: {
          start: bodyOffset + from + located.start,
          end: bodyOffset + from + located.end,
          base: content,
        },
      };
    }

    /** The text as the host now holds it: what was saved, or what is on disk. */
    function adoptContent(text) {
      content = text;
      previewStale = false;
      render({ keepImages: true }).catch((err) => console.warn('Markdown preview: images after a comment failed:', err?.message ?? err));
      sourceInstance?.update({ content: text });
    }

    /**
     * Writes the comment into the file, through the same checked path as the
     * source editor: a file that changed on disk since it was rendered is not
     * overwritten, but read again — the reader selects anew in what is there.
     */
    async function saveComment(target, text) {
      if (content !== target.base) {
        showNotice(t('fileView.markdown.comment.changed'));
        return false;
      }
      const author = await commentAuthor().catch(() => {
        // Unreadable prefs sign the comment without a name rather than lose it.
        return '';
      });
      const next = insertComment(content, target, { author, date: commentDate(), text });
      let written;
      try {
        written = await context.writeFile(next, { baseHash: await sha256Hex(target.base) });
      } catch (err) {
        console.warn('Markdown preview: the comment could not be written:', err?.message ?? err);
        written = { error: 'failed' };
      }
      if (disposed) return false;
      if (written?.ok) {
        adoptContent(next);
        showNotice(t('fileView.markdown.comment.saved'));
        return true;
      }
      if (written?.conflict === 'changed') {
        showNotice(t('fileView.markdown.comment.conflict'));
        const read = await context.readFile?.();
        if (!disposed && read && !read.error && typeof read.content === 'string') adoptContent(read.content);
        return false;
      }
      showNotice(t(written?.conflict === 'deleted'
        ? 'fileView.markdown.comment.deleted'
        : 'fileView.markdown.comment.failed'));
      return false;
    }

    /** Where a thread is in `base` now, as offsets in the whole file, or null. */
    function locateInFile(base, { blockRange, raw, occurrence }) {
      const { body } = splitDocument(base);
      if (!base.endsWith(body)) return null;
      const bodyOffset = base.length - body.length;
      const [from, to] = blockRange ?? [0, body.length];
      const where = locateThread(body.slice(from, to), raw, occurrence);
      return where ? { start: bodyOffset + from + where.start, end: bodyOffset + from + where.end } : null;
    }

    /**
     * Writes `next` in place of `base` through the same checked path as a new
     * comment: `{ ok }`, or `{ ok: false, reason }` with `changed` (the file
     * was read again), `deleted` or `failed`.
     */
    async function writeComments(base, next, what) {
      let written;
      try {
        written = await context.writeFile(next, { baseHash: await sha256Hex(base) });
      } catch (err) {
        console.warn(`Markdown preview: the ${what} could not be written:`, err?.message ?? err);
        written = { error: 'failed' };
      }
      if (disposed) return { ok: false, reason: 'failed' };
      if (written?.ok) {
        adoptContent(next);
        return { ok: true };
      }
      if (written?.conflict === 'changed') {
        const read = await context.readFile?.();
        if (!disposed && read && !read.error && typeof read.content === 'string') adoptContent(read.content);
        return { ok: false, reason: 'changed' };
      }
      return { ok: false, reason: written?.conflict === 'deleted' ? 'deleted' : 'failed' };
    }

    /** Writes a reply right after its thread (#1399); `notFound` when the thread is gone. */
    async function replyComment(thread, text) {
      const base = content;
      const where = locateInFile(base, thread);
      if (!where) return { ok: false, reason: 'notFound' };
      const author = await commentAuthor().catch(() => {
        // Unreadable prefs sign the reply without a name rather than lose it.
        return '';
      });
      if (disposed) return { ok: false, reason: 'failed' };
      if (content !== base) return { ok: false, reason: 'changed' };
      const { text: next } = insertReply(base, where.end, { author, date: commentDate(), text });
      return writeComments(base, next, 'reply');
    }

    /** Takes a comment with its replies out of the file, the passage stays (#1405). */
    async function removeComment(thread) {
      const base = content;
      const where = locateInFile(base, thread);
      if (!where) return { ok: false, reason: 'notFound' };
      return writeComments(base, removeThread(base, where), 'deletion');
    }

    const comments = createCommentUi({
      previewEl,
      articleEl,
      canComment: () => mode === MODES.PREVIEW && typeof context.writeFile === 'function' && !edit,
      isBlocked: () => editingBlocked,
      isEditing: () => Boolean(edit),
      getAuthor: commentAuthor,
      locate: locateComment,
      save: saveComment,
      reply: replyComment,
      remove: removeComment,
      notify: showNotice,
    });

    /** Why the preview cannot be edited right now, as a catalogue key, or null. */
    function lockReason() {
      if (editingBlocked) return 'fileView.edit.blocked';
      if (edit) return null;
      if (content.includes('\uFFFD')) return 'fileView.edit.notText';
      if (!canEditDocument(articleEl, content)) return 'fileView.markdown.edit.untraced';
      return null;
    }

    function renderEditState() {
      controls?.render({
        editing: Boolean(edit),
        lockReason: lockReason(),
        save: edit?.autosave.state ?? null,
        blocked: editingBlocked,
      });
    }

    function renderToolbar() {
      if (edit) edit.toolbar.render(edit.doc.state());
    }

    function onEditState() {
      if (!edit) return;
      context.setDirty?.(edit.autosave.isDirty());
      renderEditState();
    }

    /** The rendered document as the editor, for `content` as it is now. */
    function attachDocument() {
      return attachEditing(articleEl, {
        content,
        onInput: () => {
          edit?.autosave.changed();
          renderToolbar();
        },
        onSelection: renderToolbar,
        islandTitle: t('fileView.markdown.edit.island'),
      });
    }

    /**
     * Attaching must not change a byte: the document as attached has to
     * stand for the file exactly. If it does not, something on screen could
     * not be traced, and the preview is not edited at all.
     */
    function attachChecked() {
      const doc = attachDocument();
      if (doc.getText() === content) return doc;
      doc.detach();
      console.warn('Markdown preview: the document does not stand for its file; not editing it (#1422).');
      return null;
    }

    function enterEditing() {
      if (edit || disposed || !controls || mode !== MODES.PREVIEW || lockReason()) return;
      const doc = attachChecked();
      if (!doc) {
        render({ keepImages: true }).catch(warnEditFailure);
        showNotice(t('fileView.markdown.edit.untraced'));
        return;
      }
      const toolbar = createFormatToolbar({
        onFormat: (format) => {
          edit?.doc.command(format);
          renderToolbar();
        },
        onBlock: (format) => {
          edit?.doc.setBlock(format);
          renderToolbar();
        },
        onLink: (href) => {
          edit?.doc.setLink(href);
          renderToolbar();
        },
        onClose: () => edit?.doc.restoreSelection(),
        onLeave: () => edit?.doc.rememberSelection(),
      });
      const autosave = createAutosave({
        base: content,
        getText: () => edit.doc.getText(),
        write: async (text, options) => {
          const session = edit;
          const build = session?.doc.buildFor(text) ?? null;
          const written = await context.writeFile(text, options);
          if (written?.ok && !disposed) {
            content = text;
            if (edit === session && build) session.doc.rebase(build);
            sourceInstance?.update({ content: text });
          }
          return written;
        },
        onState: onEditState,
      });
      edit = { doc, autosave, toolbar };
      hostEl.insertBefore(toolbar.element, previewEl);
      hostEl.insertBefore(controls.notice, previewEl);
      comments.refresh();
      doc.focusStart(previewEl);
      renderToolbar();
      renderEditState();
    }

    /** Back to reading, without saving: whatever was to keep is kept. */
    function closeEditing({ focusToggle = false } = {}) {
      if (!edit) return;
      const { doc, autosave, toolbar } = edit;
      edit = null;
      autosave.dispose();
      toolbar.closeLink({ focus: false });
      doc.detach();
      toolbar.element.remove();
      controls.notice.remove();
      context.setDirty?.(false);
      render({ keepImages: true }).catch(warnEditFailure);
      comments.refresh();
      renderEditState();
      if (focusToggle && controls.toggle.isConnected) controls.toggle.focus();
    }

    /**
     * Saves and stops editing. False when the text could not be saved — then
     * editing goes on, and the bar above the document says why.
     */
    async function leaveEditing({ focusToggle = false } = {}) {
      if (!edit) return true;
      const session = edit;
      // Typing on while the save runs is saved as well, a few times at most.
      for (let round = 0; round < 3; round += 1) {
        if (!(await session.autosave.flush())) return false;
        if (edit !== session) return true;
        if (!session.autosave.isDirty()) break;
      }
      if (edit !== session || session.autosave.isDirty()) return false;
      closeEditing({ focusToggle });
      return true;
    }

    /** The file on disk is the text to edit now: shown anew, and edited on. */
    function reattach() {
      if (!edit) return;
      edit.doc.detach();
      render({ keepImages: true }).catch(warnEditFailure);
      const doc = attachChecked();
      if (!doc) {
        closeEditing();
        showNotice(t('fileView.markdown.edit.untraced'));
        return;
      }
      edit.doc = doc;
      doc.focusStart(previewEl);
      renderToolbar();
      renderEditState();
    }

    async function onEditPrimary() {
      if (!edit || editingBlocked) return;
      const ok = edit.autosave.state.status === SAVE_STATES.CONFLICT
        ? await edit.autosave.keepMine()
        : await edit.autosave.flush();
      if (ok) edit?.doc.restoreSelection();
    }

    async function onEditSecondary() {
      if (!edit || editingBlocked) return;
      const { status: saveStatus, conflict } = edit.autosave.state;
      const leave = saveStatus === SAVE_STATES.FAILED || conflict === 'deleted';
      const result = await context.readFile?.();
      if (!edit || disposed) return;
      const read = Boolean(result && !result.error && typeof result.content === 'string');
      if (read) content = result.content;
      edit.autosave.adopt(content);
      context.setDirty?.(false);
      sourceInstance?.update({ content });
      if (leave || !read) closeEditing({ focusToggle: true });
      else reattach();
    }

    /** The keys of the document while it is edited; true when one was taken. */
    function onEditKey(event) {
      const primary = isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        leaveEditing({ focusToggle: true }).catch(warnEditFailure);
        return true;
      }
      if (primary && !event.altKey && !event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        edit.autosave.flush().catch(warnEditFailure);
        return true;
      }
      // The way from the text to the toolbar, as in other editors.
      if (event.altKey && event.key === 'F10') {
        event.preventDefault();
        edit.toolbar.focus();
        return true;
      }
      const shortcut = matchFormatShortcut(event);
      if (!shortcut) return false;
      event.preventDefault();
      if (shortcut.block) {
        edit.doc.setBlock(shortcut.block);
      } else if (shortcut.format === FORMATS.LINK) {
        // The form shows the link at the selection as it is now, not as the
        // last `selectionchange` left it.
        edit.doc.rememberSelection();
        renderToolbar();
        edit.toolbar.openLink();
      } else {
        edit.doc.command(shortcut.format);
      }
      renderToolbar();
      return true;
    }

    /**
     * What the source gets as its context: the host's, with the tools it
     * claims kept here, and what it writes or reads taken as this file's text.
     */
    function sourceContext(sourceState) {
      const adopt = (text) => {
        if (text === content) return;
        content = text;
        previewStale = true;
      };
      return {
        ...context,
        content,
        viewState: sourceState,
        setTools: (nodes) => {
          sourceTools = nodes ?? [];
          showTools();
        },
        writeFile: async (text, options) => {
          const written = await context.writeFile(text, options);
          if (written?.ok) adopt(text);
          return written;
        },
        readFile: async () => {
          const read = await context.readFile();
          if (read && !read.error && typeof read.content === 'string') adopt(read.content);
          return read;
        },
      };
    }

    function setMode(next, { sourceState = null } = {}) {
      if (next === mode || disposed) return;
      mode = next;
      modeSwitch.select(mode);
      if (mode === MODES.SOURCE && !sourceInstance) {
        sourceInstance = plainTextView.mount(sourceEl, sourceContext(sourceState));
      }
      if (mode === MODES.PREVIEW && previewStale) {
        previewStale = false;
        void render({ keepImages: true });
      }
      previewEl.hidden = mode !== MODES.PREVIEW;
      sourceEl.hidden = mode !== MODES.SOURCE;
      comments.refresh();
      showTools();
    }

    /**
     * A switch the user asked for. Leaving the source while editing saves
     * first; if that fails, the source stays, and its bar says why.
     */
    async function requestMode(next) {
      if (next === mode || disposed) return;
      if (next === MODES.SOURCE && edit) {
        const left = await leaveEditing();
        if (disposed) return;
        if (!left) {
          modeSwitch.select(mode);
          return;
        }
      }
      if (next === MODES.PREVIEW && sourceInstance?.editing) {
        const left = await sourceInstance.leaveEditing();
        if (disposed) return;
        if (!left) {
          modeSwitch.select(mode);
          return;
        }
      }
      setMode(next);
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
      comments.decorate();
      fitTables();
      previewEl.scrollTop = scrollTop;
      renderEditState();
      return resolveImages(previous);
    }

    function prepareLinks() {
      for (const anchor of articleEl.querySelectorAll('a')) {
        // What the file says, kept aside for writing the link back while the
        // preview is edited (#1422): `href` and `title` are the view's below.
        const written = anchor.getAttribute('data-workspace-href') ?? anchor.getAttribute('href');
        const writtenTitle = anchor.getAttribute('title');
        const link = classifyLink(anchor);
        anchor.removeAttribute('data-workspace-href');
        for (const name of LINK_DATA_ATTRIBUTES) anchor.removeAttribute(name);
        if (written) anchor.setAttribute('data-md-href', written);
        if (writtenTitle) anchor.setAttribute('data-md-title', writtenTitle);
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
      // While editing, a click puts the caret into the link; ⌘-click follows it.
      if (edit && !(event.metaKey || event.ctrlKey)) return;
      if (!anchor.dataset.linkKind) return;
      void followLink(anchor);
    }

    // Only the primary click follows a link. A middle click would ask the
    // window for a new one — for a relative path there is nothing to open.
    function onAuxClick(event) {
      if (event.target.closest?.('a') && articleEl.contains(event.target)) event.preventDefault();
    }

    /** ⌘+ / ⌘− / ⌘0 while the preview has focus, as in the image preview. */
    function onKeyDown(event) {
      if (edit && onEditKey(event)) return;
      if (isCommentShortcut(event)) {
        if (comments.composeFromSelection()) event.preventDefault();
        return;
      }
      if (event.altKey || !(event.metaKey || event.ctrlKey)) return;
      if (event.key === '+' || event.key === '=') setZoom(nextZoom(zoom, 1, MARKDOWN_ZOOM_STEPS));
      else if (event.key === '-') setZoom(nextZoom(zoom, -1, MARKDOWN_ZOOM_STEPS));
      else if (event.key === '0') setZoom(1);
      else return;
      event.preventDefault();
    }

    previewEl.addEventListener('click', onClick);
    previewEl.addEventListener('auxclick', onAuxClick);
    previewEl.addEventListener('keydown', onKeyDown);

    const stopFollowingLocale = onLocaleChange(() => {
      modeSwitch.applyLabels();
      applyToolLabels();
      comments.applyLabels();
      if (edit) {
        // Rendering anew would throw the reader's undo history away.
        edit.toolbar.applyLabels();
        renderEditState();
        return;
      }
      void render({ keepImages: true });
    });

    /**
     * Back to where the reader was when the history left this file (#822):
     * the same side of "Preview | Source", the same place in it. Images above
     * that place arrive later and push it down; once they are in it is set
     * again — unless the reader has scrolled meanwhile.
     */
    function restoreView(state, imagesSettled) {
      if (state.mode === MODES.SOURCE) {
        setMode(MODES.SOURCE, { sourceState: state.source ?? null });
        return;
      }
      const top = Number(state.top) || 0;
      const left = Number(state.left) || 0;
      previewEl.scrollTop = top;
      previewEl.scrollLeft = left;
      const placed = previewEl.scrollTop;
      void imagesSettled.then(() => {
        if (disposed || previewEl.scrollTop !== placed) return;
        previewEl.scrollTop = top;
        previewEl.scrollLeft = left;
      });
    }

    const firstImages = render();
    // A place the reader left wins over the heading the link named.
    if (context.viewState) restoreView(context.viewState, firstImages);
    else if (context.fragment) revealOnOpen(context.fragment, firstImages);

    return {
      update({ content: next }) {
        if (edit) {
          // Never under the caret: only text that loses nothing of the
          // reader's is taken, anything else is a conflict for them to settle.
          const answer = edit.autosave.external(next);
          if (answer === 'replace') {
            content = next;
            reattach();
          } else if (answer === 'ignore' && !edit.autosave.isDirty()) {
            content = next;
          }
          sourceInstance?.update({ content });
          return;
        }
        content = next;
        previewStale = false;
        void render();
        sourceInstance?.update({ content: next });
      },
      /** Unsaved text of the preview's editor or the source's (#863, #1422). */
      async save() {
        if (edit) return (await edit.autosave.flush()) && !edit.autosave.isDirty();
        return sourceInstance?.save?.() ?? true;
      },
      setEditingBlocked(blocked) {
        editingBlocked = Boolean(blocked);
        comments.refresh();
        sourceInstance?.setEditingBlocked?.(blocked);
        renderEditState();
        if (editingBlocked && edit) leaveEditing().catch(warnEditFailure);
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
        if (edit) {
          edit.autosave.dispose();
          edit.doc.detach();
          edit.toolbar.element.remove();
          edit = null;
        }
        comments.dispose();
        previewEl.removeEventListener('click', onClick);
        previewEl.removeEventListener('auxclick', onAuxClick);
        previewEl.removeEventListener('keydown', onKeyDown);
        sourceInstance?.unmount();
      },
      /** Where the reader is, for the way back (#822). */
      viewState() {
        return {
          mode,
          top: previewEl.scrollTop,
          left: previewEl.scrollLeft,
          source: sourceInstance?.viewState?.() ?? null,
        };
      },
      /** Commands from outside the view — the menu shortcut (#344). */
      command(name) {
        if (name !== 'toggle-source') return false;
        void requestMode(mode === MODES.PREVIEW ? MODES.SOURCE : MODES.PREVIEW);
        return true;
      },
      /** For tests: the comment form or popover that is open, if any (#1388). */
      get commentOpen() {
        return comments.openKind;
      },
      /** For tests: which of the two is on show. */
      get mode() {
        return mode;
      },
      /** Is the preview being edited (#1422)? */
      get editing() {
        return Boolean(edit);
      },
    };
  },
};
