// Editing in the Markdown preview (#1422): the rendered document becomes the
// editor.
//
// Decided on 2026-11-24 in the issue, against a WYSIWYG library and against a
// live preview on CodeMirror: the preview the reader already knows is made
// editable (`contenteditable`), and what changed goes back into the file
// block by block. Every top-level block knows where it came from in the
// source (`data-md-range`); a block the reader did not touch keeps its source
// byte for byte, a changed one is written anew (`markdown-serialize.js`), and
// `markdown-splice.js` puts the pieces together. So a changed word is a
// changed block in `git diff`, never a rewritten file.
//
// What the preview cannot write back without losing something — a table, a
// code block, an image, HTML — is an island: not editable here, with a
// tooltip that sends the reader to the source. The front matter is one too.
//
// Formatting uses the browser's editing commands (`execCommand`), so that
// undo and redo stay the browser's own and cover every step.
//
// This module owns the document while it is edited: attaching, the text it
// stands for, the commands, and the state at the caret for the toolbar.
// Saving, the toggle and the toolbar itself live in `markdown-view.js` and
// `markdown-toolbar.js`.

import { splitDocument } from './markdown-document.js';
import { isEditableBlock, serializeBlock } from './markdown-serialize.js';
import { spliceBlocks } from './markdown-splice.js';

const ELEMENT = 1;
const TEXT = 3;

export const FORMATS = Object.freeze({
  BOLD: 'bold',
  ITALIC: 'italic',
  STRIKE: 'strike',
  CODE: 'code',
  LINK: 'link',
  BULLETS: 'bullets',
  NUMBERED: 'numbered',
  TASKS: 'tasks',
  QUOTE: 'quote',
});

/** The block formats of the toolbar's select: a paragraph or a heading. */
export const BLOCK_FORMATS = Object.freeze(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const HEADINGS = 'h1, h2, h3, h4, h5, h6';
/** Elements that belong inside a line; anything else at the top is a block. */
const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BR', 'CODE', 'DEL', 'EM', 'FONT', 'I', 'IMG', 'INPUT', 'KBD',
  'MARK', 'S', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'U', 'BUTTON']);
/** What the browser's own commands would do and Markdown cannot say. */
const REFUSED_INPUT = new Set(['formatUnderline', 'formatSuperscript', 'formatSubscript', 'formatJustifyFull',
  'formatJustifyCenter', 'formatJustifyRight', 'formatJustifyLeft', 'formatIndent', 'formatOutdent',
  'formatFontColor', 'formatBackColor', 'formatFontName', 'insertFromDrop', 'deleteByDrag']);
/** A native bold this recent was the key itself; the menu's ⌘B that follows it is the same key (#1422). */
const SAME_KEY_MS = 500;
/**
 * Inserted after an element `insertHTML` puts in. Without it, Chromium
 * merges the element into the text that follows and keeps only a `<span>`
 * of it. Invisible, and never written: the serializer drops it.
 */
const SEAM = '\u200b';

function rangeOf(el) {
  const value = el.getAttribute?.('data-md-range');
  if (!value) return null;
  const [start, end] = value.split(':').map(Number);
  return Number.isInteger(start) && Number.isInteger(end) && end >= start ? { start, end } : null;
}

const isUiOnly = (el) => el.classList.contains('md-front-matter');

/**
 * Can the document on screen be edited? Only when every block the reader
 * sees is traced to its place in the source, and the body it was traced in
 * is the end of `content` — anything else could not be written back without
 * guessing.
 */
export function canEditDocument(articleEl, content) {
  const text = String(content ?? '');
  if (!text.endsWith(splitDocument(text).body)) return false;
  for (const el of articleEl.children) {
    if (isUiOnly(el) || el.classList.contains('md-empty')) continue;
    if (!rangeOf(el)) return false;
  }
  return true;
}

/** The style a list was written in, so that a changed list keeps it. */
function listStyleOf(raw) {
  const bullet = /^\s*([-*+])\s/.exec(raw)?.[1];
  const orderedDelimiter = /^\s*\d{1,9}([.)])\s/.exec(raw)?.[1];
  return { bullet, orderedDelimiter };
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Makes `articleEl` — the rendered `content` — editable. `onInput()` runs
 * after every change the reader makes, `onSelection()` when the caret moves
 * inside the document.
 */
export function attachEditing(articleEl, { content, onInput = () => {}, onSelection = () => {}, islandTitle = '' }) {
  const text = String(content ?? '');
  const { body: initialBody } = splitDocument(text);
  const prefix = text.endsWith(initialBody) ? text.slice(0, text.length - initialBody.length) : '';
  let body = initialBody;
  let blocks = [];
  // Every block on screen that is not new: its index in `blocks`, whether it
  // is an island, its Markdown as it was last written, and its list style.
  const known = new Map();
  const defaults = { ...listStyleOf(/^\s*[-*+]\s/m.exec(body)?.[0] ?? '') };
  let version = 0;
  let cache = null;
  let lastRange = null;
  let nativeBoldAt = 0;
  const islands = [];

  // An empty document has a line to type into instead of its notice.
  const empty = articleEl.querySelector(':scope > .md-empty');
  if (empty) {
    const line = document.createElement('p');
    line.append(document.createElement('br'));
    empty.replaceWith(line);
  }

  function makeIsland(el) {
    el.setAttribute('contenteditable', 'false');
    el.classList.add('md-island');
    if (islandTitle) el.title = islandTitle;
    islands.push(el);
  }

  for (const el of articleEl.children) {
    if (isUiOnly(el)) {
      makeIsland(el);
      continue;
    }
    const range = rangeOf(el);
    if (!range) continue;
    const index = blocks.push(range) - 1;
    const island = !isEditableBlock(el);
    const options = { ...defaults, ...listStyleOf(body.slice(range.start, range.end)) };
    if (island) makeIsland(el);
    known.set(el, { index, island, options, baseline: island ? null : serializeBlock(el, options) });
  }
  // A comment's marker is a button between words (#1388). Inside an edited
  // line it would split the line for the browser's commands — a heading
  // would stop at it — so it leaves while the document is edited; the
  // passage keeps its highlight, and leaving renders the markers anew.
  for (const marker of articleEl.querySelectorAll('.md-comment-marker')) marker.remove();

  // ── The text the document now stands for ─────────────────────────────────

  /**
   * The top-level units in order: an element, or a run of loose inline nodes
   * the editing engine left at the top (keyed by its first node). Blank text
   * between blocks is no unit.
   */
  function units() {
    const list = [];
    let run = null;
    for (const node of articleEl.childNodes) {
      const inline = node.nodeType === TEXT || (node.nodeType === ELEMENT && INLINE_TAGS.has(node.tagName));
      if (!inline) {
        run = null;
        if (node.nodeType === ELEMENT) list.push({ key: node, el: node });
        continue;
      }
      if (node.nodeType === TEXT && !node.data.trim() && !run) continue;
      if (!run) {
        run = { key: node, nodes: [] };
        list.push(run);
      }
      run.nodes.push(node);
    }
    return list;
  }

  // The Markdown of each unit as last written, until something inside it
  // changes: a keystroke writes its own block anew, not the whole document.
  const written = new Map();
  const isRunKey = (key) => key.nodeType !== ELEMENT || INLINE_TAGS.has(key.tagName);

  /** The child of the document that holds `node`; the document itself; or null when detached. */
  function topLevelOf(node) {
    for (let at = node; at; at = at.parentNode) {
      if (at === articleEl || at.parentNode === articleEl) return at;
    }
    return null;
  }

  function forget(records) {
    if (!records.length) return;
    version += 1;
    for (const record of records) {
      const top = topLevelOf(record.target);
      if (top === null) {
        written.clear();
        return;
      }
      if (top !== articleEl && !isRunKey(top)) {
        written.delete(top);
        continue;
      }
      // Loose inline nodes at the top: their runs are read again.
      for (const key of [...written.keys()]) if (isRunKey(key)) written.delete(key);
    }
  }

  function serializeUnit(unit, options) {
    if (written.has(unit.key)) return written.get(unit.key);
    let markdown;
    if (unit.el) {
      markdown = serializeBlock(unit.el, options);
    } else {
      const line = document.createElement('p');
      for (const node of unit.nodes) line.append(node.cloneNode(true));
      markdown = serializeBlock(line, options);
    }
    written.set(unit.key, markdown);
    return markdown;
  }

  function build() {
    const entries = [];
    const items = [];
    let last = -1;
    for (const unit of units()) {
      if (unit.el && isUiOnly(unit.el)) continue;
      const info = known.get(unit.key);
      const options = info?.options ?? defaults;
      let orig = info ? info.index : null;
      // A block the engine copied or moved is written as a new one.
      if (orig !== null && orig <= last) orig = null;
      if (orig !== null) last = orig;
      let serialized = null;
      let markdown = null;
      if (info?.island) {
        if (orig === null) markdown = body.slice(blocks[info.index].start, blocks[info.index].end);
      } else {
        serialized = serializeUnit(unit, options);
        markdown = orig !== null && serialized === info.baseline ? null : serialized;
      }
      items.push({ orig, text: markdown });
      entries.push({ key: unit.key, island: Boolean(info?.island), options, serialized });
    }
    const spliced = spliceBlocks(body, blocks, items);
    return { text: prefix + spliced.text, entries, ranges: spliced.ranges };
  }

  const observer = new MutationObserver(forget);
  observer.observe(articleEl, { subtree: true, childList: true, characterData: true, attributes: true });

  function current() {
    forget(observer.takeRecords());
    if (!cache || cache.version !== version) cache = { version, build: build() };
    return cache.build;
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  function selectionRange() {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return articleEl.contains(range.commonAncestorContainer) ? range : null;
  }

  function elementAt(node) {
    return node?.nodeType === ELEMENT ? node : node?.parentElement ?? null;
  }

  /**
   * Back into the document, where the caret last was. Coming from the
   * toolbar's select or the link form, focusing the document alone would put
   * the caret at its start.
   */
  function restoreSelection() {
    const wasFocused = document.activeElement === articleEl;
    if (!wasFocused) articleEl.focus({ preventScroll: true });
    if (wasFocused && selectionRange()) return true;
    if (!lastRange || !articleEl.contains(lastRange.startContainer)) return Boolean(selectionRange());
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(lastRange);
    return true;
  }

  function onSelectionChange() {
    if (!rememberSelection()) return;
    onSelection();
  }

  /**
   * Keeps the current selection for `restoreSelection()`. `selectionchange`
   * arrives a task later; whatever moves the focus out of the document — the
   * link form — calls this first, or a quick key would act on the selection
   * before (#1422, seen on the macOS runner).
   */
  function rememberSelection() {
    const range = selectionRange();
    if (!range) return false;
    lastRange = range.cloneRange();
    return true;
  }

  // ── State at the caret ────────────────────────────────────────────────────

  function state() {
    const range = selectionRange() ?? lastRange;
    if (!range || !articleEl.contains(range.startContainer)) return null;
    const el = elementAt(range.startContainer);
    if (!el) return null;
    if (el.closest('[contenteditable="false"]')) return { island: true };
    const heading = el.closest(HEADINGS);
    const query = (name) => {
      try {
        return document.queryCommandState(name);
      } catch {
        // An engine without the command (a DOM test) has no format to show.
        return false;
      }
    };
    const item = el.closest('li');
    return {
      island: false,
      block: heading ? heading.tagName.toLowerCase() : 'p',
      heading: Boolean(heading),
      // A heading is bold by its style, not by `**`.
      bold: !heading && query('bold'),
      italic: query('italic'),
      strike: query('strikeThrough'),
      code: Boolean(el.closest('code')),
      link: el.closest('a')?.getAttribute('data-md-href') ?? el.closest('a')?.getAttribute('href') ?? null,
      list: el.closest('ul, ol')?.tagName.toLowerCase() ?? null,
      task: Boolean(item && [...item.children].some((child) => child.tagName === 'INPUT' && child.type === 'checkbox')),
      quote: Boolean(el.closest('blockquote')),
      collapsed: range.collapsed,
    };
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  const exec = (name, value = null) => document.execCommand(name, false, value);

  /** A caret in a word stands for the word, as in a word processor. */
  function wordAtCaret() {
    const selection = document.getSelection();
    if (!selection.isCollapsed) return true;
    selection.modify('move', 'backward', 'word');
    selection.modify('extend', 'forward', 'word');
    // Only the word, not the blank after it.
    const text = selection.toString();
    const trail = text.length - text.trimEnd().length;
    for (let i = 0; i < trail; i += 1) selection.modify('extend', 'backward', 'character');
    return !selection.isCollapsed;
  }

  function toggleCode() {
    const range = selectionRange();
    if (!range) return false;
    const code = elementAt(range.startContainer)?.closest('code');
    if (code && articleEl.contains(code)) {
      const selection = document.getSelection();
      const whole = document.createRange();
      whole.selectNode(code);
      selection.removeAllRanges();
      selection.addRange(whole);
      return exec('insertText', code.textContent);
    }
    if (!wordAtCaret()) return false;
    const picked = selectionRange();
    const blockOf = (node) => elementAt(node)?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote');
    if (!picked || blockOf(picked.startContainer) !== blockOf(picked.endContainer)) return false;
    const textOf = picked.toString();
    if (!textOf) return false;
    return exec('insertHTML', `<code>${escapeHtml(textOf)}</code>${SEAM}`);
  }

  function toggleTasks() {
    let range = selectionRange();
    if (!range) return false;
    let list = elementAt(range.startContainer)?.closest('ul, ol');
    if (!list || list.tagName !== 'UL') {
      exec('insertUnorderedList');
      range = selectionRange();
      list = range ? elementAt(range.startContainer)?.closest('ul') : null;
      if (!list) return false;
    }
    const items = [...list.children].filter((child) => child.tagName === 'LI');
    const boxOf = (item) => [...item.children].find((child) => child.tagName === 'INPUT' && child.type === 'checkbox');
    const allTasks = items.every((item) => boxOf(item));
    for (const item of items) {
      const box = boxOf(item);
      if (allTasks) {
        box?.remove();
      } else if (!box) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.disabled = true;
        item.prepend(input);
      }
    }
    onInput();
    return true;
  }

  function toggleQuote() {
    const range = selectionRange();
    if (!range) return false;
    const quote = elementAt(range.startContainer)?.closest('blockquote');
    if (quote && articleEl.contains(quote)) return exec('outdent');
    return exec('formatBlock', 'blockquote');
  }

  /**
   * Runs a format. False when there was nothing to run it on: no caret in
   * the document, an island, bold in a heading.
   */
  function command(name) {
    if (!restoreSelection()) return false;
    const at = state();
    if (!at || at.island) return false;
    switch (name) {
      case FORMATS.BOLD:
        return at.heading ? false : exec('bold');
      case FORMATS.ITALIC:
        return exec('italic');
      case FORMATS.STRIKE:
        return exec('strikeThrough');
      case FORMATS.CODE:
        return toggleCode();
      case FORMATS.BULLETS:
        // In a checklist the bullet button takes the boxes off; the list stays.
        return at.task ? toggleTasks() : exec('insertUnorderedList');
      case FORMATS.NUMBERED:
        if (at.task) toggleTasks();
        return exec('insertOrderedList');
      case FORMATS.TASKS:
        return toggleTasks();
      case FORMATS.QUOTE:
        return toggleQuote();
      default:
        return false;
    }
  }

  /** A paragraph, or a heading of a level: 'p', 'h1' … 'h6'. */
  function setBlock(format) {
    if (!BLOCK_FORMATS.includes(format) || !restoreSelection()) return false;
    const at = state();
    if (!at || at.island) return false;
    return exec('formatBlock', format);
  }

  /** Sets or replaces the link at the selection; an empty address removes it. */
  function setLink(href) {
    if (!restoreSelection()) return false;
    const range = selectionRange();
    if (!range) return false;
    const selection = document.getSelection();
    const existing = elementAt(range.startContainer)?.closest('a');
    if (existing && articleEl.contains(existing)) {
      const whole = document.createRange();
      whole.selectNodeContents(existing);
      selection.removeAllRanges();
      selection.addRange(whole);
    }
    const address = String(href ?? '').trim();
    if (!address) return existing ? exec('unlink') : false;
    if (selection.isCollapsed && !wordAtCaret()) {
      return exec('insertHTML', `<a href="${escapeHtml(address)}" data-md-href="${escapeHtml(address)}">${escapeHtml(address)}</a>${SEAM}`);
    }
    if (!exec('createLink', address)) return false;
    // The view keeps the written address aside (`data-md-href`); a link the
    // reader just set carries the new one.
    const after = selectionRange();
    const anchor = after ? elementAt(after.startContainer)?.closest('a') ?? elementAt(after.commonAncestorContainer)?.querySelector('a') : null;
    for (const a of articleEl.querySelectorAll('a')) {
      if (a === anchor || (a.getAttribute('href') === address && !a.hasAttribute('data-md-href'))) {
        a.setAttribute('data-md-href', address);
        a.removeAttribute('data-md-title');
      }
    }
    return true;
  }

  // ── Input the document refuses or reshapes ────────────────────────────────

  function onBeforeInput(event) {
    if (REFUSED_INPUT.has(event.inputType)) {
      event.preventDefault();
      return;
    }
    if (event.inputType === 'formatBold') {
      nativeBoldAt = Date.now();
      if (state()?.heading) event.preventDefault();
    }
  }

  /** Only the text of a paste: formats come from the toolbar, not from another app. */
  function onPaste(event) {
    const plain = event.clipboardData?.getData('text/plain');
    if (typeof plain !== 'string') return;
    event.preventDefault();
    if (plain) exec('insertText', plain.replace(/\r\n?/g, '\n'));
  }

  const refuseDrop = (event) => event.preventDefault();

  /**
   * ⌘B is also the menu's "Toggle Sidebar" (#167). The app asks the focused
   * element first (`snotra:format-shortcut`); in the document it means bold.
   */
  function onFormatShortcut(event) {
    if (event.detail?.command !== FORMATS.BOLD) return;
    event.preventDefault();
    if (Date.now() - nativeBoldAt < SAME_KEY_MS) return;
    command(FORMATS.BOLD);
  }

  const onInputEvent = () => onInput();

  articleEl.setAttribute('contenteditable', 'true');
  articleEl.spellcheck = false;
  articleEl.classList.add('md-doc--editing');
  try {
    exec('defaultParagraphSeparator', 'p');
    exec('styleWithCSS', false);
  } catch {
    // A document without the commands (a DOM test) edits nothing anyway.
  }
  articleEl.addEventListener('beforeinput', onBeforeInput);
  articleEl.addEventListener('paste', onPaste);
  articleEl.addEventListener('drop', refuseDrop);
  articleEl.addEventListener('dragover', refuseDrop);
  articleEl.addEventListener('input', onInputEvent);
  articleEl.addEventListener('snotra:format-shortcut', onFormatShortcut);
  document.addEventListener('selectionchange', onSelectionChange);

  /**
   * Into the document: where the reader had selected something, or at the
   * start of the first editable block in view — not at the top of a
   * document they had scrolled down in.
   */
  function focusStart(scroller) {
    const selected = selectionRange()?.cloneRange() ?? null;
    articleEl.focus({ preventScroll: true });
    if (selected && !elementAt(selected.startContainer)?.closest('[contenteditable="false"]')) {
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(selected);
      return;
    }
    const top = scroller?.getBoundingClientRect().top ?? -Infinity;
    const candidates = [...articleEl.children].filter((el) => !el.hasAttribute('contenteditable'));
    const target = candidates.find((el) => el.getBoundingClientRect().bottom > top) ?? candidates[0];
    if (!target) return;
    const range = document.createRange();
    range.setStart(target, 0);
    range.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  return {
    /** The whole file as the document now stands. */
    getText() {
      return current().text;
    },
    /** The build that produced `text`, if it is the last one — for `rebase()`. */
    buildFor(text) {
      const build = current();
      return build.text === text ? build : null;
    },
    /**
     * `build`'s text is on disk now: it is what the next change is measured
     * against, and its blocks are where they stand in it.
     */
    rebase(build) {
      if (!build) return;
      body = build.text.slice(prefix.length);
      blocks = [];
      build.entries.forEach((entry, i) => {
        const range = build.ranges[i];
        if (!range) {
          known.delete(entry.key);
          return;
        }
        const index = blocks.push(range) - 1;
        known.set(entry.key, { index, island: entry.island, options: entry.options, baseline: entry.serialized });
      });
      version += 1;
    },
    state,
    command,
    setBlock,
    setLink,
    rememberSelection,
    restoreSelection,
    focusStart,
    detach() {
      observer.disconnect();
      articleEl.removeEventListener('beforeinput', onBeforeInput);
      articleEl.removeEventListener('paste', onPaste);
      articleEl.removeEventListener('drop', refuseDrop);
      articleEl.removeEventListener('dragover', refuseDrop);
      articleEl.removeEventListener('input', onInputEvent);
      articleEl.removeEventListener('snotra:format-shortcut', onFormatShortcut);
      document.removeEventListener('selectionchange', onSelectionChange);
      articleEl.removeAttribute('contenteditable');
      articleEl.classList.remove('md-doc--editing');
      for (const el of islands) {
        el.removeAttribute('contenteditable');
        el.classList.remove('md-island');
        if (islandTitle && el.title === islandTitle) el.removeAttribute('title');
      }
    },
  };
}
