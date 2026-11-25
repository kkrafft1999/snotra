// The formatting toolbar of the Markdown preview while it is edited (#1422).
//
// Decided on 2026-11-24 from three mockups (a fixed bar below the header,
// tools inside the header, a floating bar at the selection): a fixed row
// below the file header, shown while *Edit* is on. From left to right the
// block format (paragraph, heading 1–3), bold, italic, strikethrough, code
// and link, then bullet list, numbered list, checklist and quote. The buttons
// show the state at the caret.
//
// A WAI-ARIA toolbar: one tab stop, the arrow keys move between the controls.
// The buttons do not take the focus from the document on a click, so that
// the selection they act on stays where it is.

import { t } from '../i18n.js';
import { BLOCK_LEVEL, FORMATS } from './markdown-editing.js';

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent ?? '');

const svg = (inner) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ICONS = Object.freeze({
  [FORMATS.BOLD]: svg('<path d="M4.5 2.75h4.1a2.6 2.6 0 0 1 0 5.2H4.5zM4.5 7.95h4.8a2.65 2.65 0 0 1 0 5.3H4.5z" stroke-width="1.9"/>'),
  [FORMATS.ITALIC]: svg('<path d="M7.2 2.75h5M3.8 13.25h5M9.7 2.75 6.3 13.25"/>'),
  [FORMATS.STRIKE]: svg('<path d="M2.5 8h11"/><path d="M11.2 4.6C10.7 3.4 9.5 2.75 8 2.75c-1.9 0-3.2 1-3.2 2.4 0 .8.4 1.4 1.1 1.8M4.8 11.4c.5 1.2 1.7 1.85 3.2 1.85 2 0 3.3-1 3.3-2.5 0-.4-.1-.7-.2-1"/>'),
  [FORMATS.CODE]: svg('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
  [FORMATS.LINK]: svg('<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>'),
  [FORMATS.BULLETS]: svg('<circle cx="3" cy="4" r=".9" fill="currentColor"/><circle cx="3" cy="8" r=".9" fill="currentColor"/><circle cx="3" cy="12" r=".9" fill="currentColor"/><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/>'),
  [FORMATS.NUMBERED]: svg('<path d="M2.3 3 3.3 2.4v3.5" stroke-width="1.2"/><path d="M2.3 9.3c.2-.5.6-.8 1.1-.8.6 0 1 .4 1 .9 0 .9-2.1 1.5-2.1 2.6h2.2" stroke-width="1.2"/><path d="M7 4h6.5M7 11h6.5"/>'),
  [FORMATS.TASKS]: svg('<rect x="2" y="2.5" width="4.5" height="4.5" rx="1"/><path d="M3.1 4.8 4 5.7l1.4-1.7"/><rect x="2" y="9" width="4.5" height="4.5" rx="1"/><path d="M9 4.75h4.5M9 11.25h4.5"/>'),
  [FORMATS.QUOTE]: svg('<path d="M3 3v10" stroke-width="2"/><path d="M6.5 5h7M6.5 8h7M6.5 11h5"/>'),
});

/** The buttons in their groups, in the order they stand. */
const GROUPS = Object.freeze([
  [FORMATS.BOLD, FORMATS.ITALIC, FORMATS.STRIKE, FORMATS.CODE, FORMATS.LINK],
  [FORMATS.BULLETS, FORMATS.NUMBERED, FORMATS.TASKS, FORMATS.QUOTE],
]);

/**
 * Every key the toolbar answers to, in one place — `code` is the physical
 * key, so that ⇧⌘7 is the same key on a German keyboard, where ⇧7 types `/`.
 * ⌘B also toggles the sidebar from the menu (#167); the document takes it
 * through `snotra:format-shortcut` instead of a key handler. ⌘I is the
 * browser's own. Quote has no key: ⇧⌘. shows hidden files (#436).
 */
export const FORMAT_SHORTCUTS = Object.freeze([
  Object.freeze({ format: FORMATS.BOLD, code: 'KeyB', native: true }),
  Object.freeze({ format: FORMATS.ITALIC, code: 'KeyI', native: true }),
  Object.freeze({ format: FORMATS.STRIKE, code: 'KeyX', shift: true }),
  Object.freeze({ format: FORMATS.CODE, code: 'KeyE' }),
  Object.freeze({ format: FORMATS.LINK, code: 'KeyK' }),
  Object.freeze({ format: FORMATS.NUMBERED, code: 'Digit7', shift: true }),
  Object.freeze({ format: FORMATS.BULLETS, code: 'Digit8', shift: true }),
  Object.freeze({ format: FORMATS.TASKS, code: 'Digit9', shift: true }),
  Object.freeze({ block: 'p', code: 'Digit0', alt: true }),
  Object.freeze({ block: 'h1', code: 'Digit1', alt: true }),
  Object.freeze({ block: 'h2', code: 'Digit2', alt: true }),
  Object.freeze({ block: 'h3', code: 'Digit3', alt: true }),
]);

/** The shortcut a key event stands for, or null. Native ones are left to the browser. */
export function matchFormatShortcut(event) {
  const primary = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return null;
  return FORMAT_SHORTCUTS.find((entry) => !entry.native
    && entry.code === event.code
    && Boolean(entry.shift) === event.shiftKey
    && Boolean(entry.alt) === event.altKey) ?? null;
}

function shortcutLabel(entry) {
  const key = entry.code.replace(/^(Key|Digit)/, '');
  if (isMac()) return `${entry.alt ? '⌥' : ''}${entry.shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${entry.alt ? 'Alt+' : ''}${entry.shift ? 'Shift+' : ''}${key}`;
}

const LABEL_KEYS = Object.freeze({
  [FORMATS.BOLD]: 'fileView.markdown.format.bold',
  [FORMATS.ITALIC]: 'fileView.markdown.format.italic',
  [FORMATS.STRIKE]: 'fileView.markdown.format.strike',
  [FORMATS.CODE]: 'fileView.markdown.format.code',
  [FORMATS.LINK]: 'fileView.markdown.format.link',
  [FORMATS.BULLETS]: 'fileView.markdown.format.bullets',
  [FORMATS.NUMBERED]: 'fileView.markdown.format.numbered',
  [FORMATS.TASKS]: 'fileView.markdown.format.tasks',
  [FORMATS.QUOTE]: 'fileView.markdown.format.quote',
});

const BLOCK_OPTIONS = Object.freeze(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Offered in the select; a deeper heading only shows while the caret is in one. */
const OFFERED_BLOCKS = new Set(['p', 'h1', 'h2', 'h3']);

/**
 * Builds the toolbar. `onFormat(format)` and `onBlock(format)` run what the
 * reader picked; `onLink(href)` sets a link (an empty one removes it);
 * `onClose()` gives the focus back to the document; `onLeave()` runs just
 * before the link form takes the focus from it.
 */
export function createFormatToolbar({ onFormat, onBlock, onLink, onClose, onLeave = () => {} }) {
  const bar = document.createElement('div');
  bar.className = 'md-format-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-orientation', 'horizontal');

  // The chevron is drawn here rather than as a background image, so that it
  // takes its colour from the tokens in light and dark.
  const blockWrap = document.createElement('span');
  blockWrap.className = 'md-format-bar__block-wrap';
  const block = document.createElement('select');
  block.className = 'md-format-bar__block';
  for (const value of BLOCK_OPTIONS) {
    const option = document.createElement('option');
    option.value = value;
    option.hidden = !OFFERED_BLOCKS.has(value);
    block.append(option);
  }
  blockWrap.append(block);
  blockWrap.insertAdjacentHTML('beforeend', svg('<path d="M4.5 6.5 8 10l3.5-3.5"/>'));
  bar.append(blockWrap);

  const buttons = new Map();
  for (const group of GROUPS) {
    const separator = document.createElement('span');
    separator.className = 'md-format-bar__separator';
    separator.setAttribute('aria-hidden', 'true');
    bar.append(separator);
    for (const format of group) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'md-format-bar__button';
      button.dataset.format = format;
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = ICONS[format];
      buttons.set(format, button);
      bar.append(button);
    }
  }

  // ── The link form ─────────────────────────────────────────────────────────

  const popover = document.createElement('form');
  popover.className = 'md-link-popover';
  popover.setAttribute('role', 'dialog');
  popover.hidden = true;
  const fieldId = `md-link-address-${Math.random().toString(36).slice(2, 8)}`;
  const fieldLabel = document.createElement('label');
  fieldLabel.className = 'md-link-popover__label';
  fieldLabel.htmlFor = fieldId;
  const field = document.createElement('input');
  field.type = 'text';
  field.id = fieldId;
  field.className = 'modal-input md-link-popover__field';
  field.autocomplete = 'off';
  field.spellcheck = false;
  const actions = document.createElement('div');
  actions.className = 'md-link-popover__actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn-secondary';
  const apply = document.createElement('button');
  apply.type = 'submit';
  apply.className = 'btn-primary';
  actions.append(remove, apply);
  popover.append(fieldLabel, field, actions);
  bar.append(popover);

  function closeLink({ focus = true } = {}) {
    if (popover.hidden) return;
    popover.hidden = true;
    buttons.get(FORMATS.LINK).setAttribute('aria-expanded', 'false');
    if (focus) onClose();
  }

  popover.addEventListener('submit', (event) => {
    event.preventDefault();
    const href = field.value.trim();
    closeLink({ focus: false });
    onLink(href);
  });
  remove.addEventListener('click', () => {
    closeLink({ focus: false });
    onLink('');
  });
  popover.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeLink();
  });
  popover.addEventListener('focusout', (event) => {
    if (!popover.contains(event.relatedTarget)) closeLink({ focus: false });
  });

  /** Opens the link form under the link button, with the link at the caret. */
  function openLink(href) {
    onLeave();
    const button = buttons.get(FORMATS.LINK);
    field.value = href ?? '';
    remove.hidden = !href;
    popover.style.setProperty('--md-link-left', `${button.offsetLeft}px`);
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    field.focus();
    field.select();
  }

  // ── Keyboard: one tab stop, arrows between the controls ──────────────────

  const controls = () => [block, ...buttons.values()].filter((el) => !el.disabled);
  let active = block;

  function setActive(next, { focus = false } = {}) {
    active = next;
    for (const el of [block, ...buttons.values()]) el.tabIndex = el === active ? 0 : -1;
    if (focus) next.focus();
  }

  bar.addEventListener('keydown', (event) => {
    if (popover.contains(event.target)) return;
    const list = controls();
    const at = list.indexOf(event.target);
    if (at === -1) return;
    let next = null;
    if (event.key === 'ArrowRight') next = list[(at + 1) % list.length];
    else if (event.key === 'ArrowLeft') next = list[(at - 1 + list.length) % list.length];
    else if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list.at(-1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!next) return;
    event.preventDefault();
    setActive(next, { focus: true });
  });
  bar.addEventListener('focusin', (event) => {
    if ([block, ...buttons.values()].includes(event.target)) setActive(event.target);
  });

  // A click keeps the focus — and with it the selection — in the document.
  for (const button of buttons.values()) {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      const format = button.dataset.format;
      if (format === FORMATS.LINK) {
        if (popover.hidden) openLink(currentLink);
        else closeLink();
        return;
      }
      onFormat(format);
    });
  }
  block.addEventListener('change', () => onBlock(block.value));

  // ── State ─────────────────────────────────────────────────────────────────

  let currentLink = null;

  function applyLabels() {
    bar.setAttribute('aria-label', t('fileView.markdown.format.label'));
    block.setAttribute('aria-label', t('fileView.markdown.format.block'));
    for (const option of block.options) {
      option.textContent = option.value === 'p'
        ? t('fileView.markdown.format.paragraph')
        : t('fileView.markdown.format.heading', { level: option.value.slice(1) });
    }
    for (const [format, button] of buttons) {
      const label = t(LABEL_KEYS[format]);
      const shortcut = FORMAT_SHORTCUTS.find((entry) => entry.format === format);
      button.setAttribute('aria-label', label);
      button.title = shortcut ? `${label} (${shortcutLabel(shortcut)})` : label;
    }
    popover.setAttribute('aria-label', t('fileView.markdown.link.dialog'));
    fieldLabel.textContent = t('fileView.markdown.link.address');
    field.placeholder = t('fileView.markdown.link.placeholder');
    apply.textContent = t('fileView.markdown.link.apply');
    remove.textContent = t('fileView.markdown.link.remove');
  }

  /** Shows the state at the caret; null or an island turns the tools off. */
  function render(state) {
    const off = !state || state.island;
    // A table cell holds one line: the block formats wait outside it (#1430).
    block.disabled = off || Boolean(state.cell);
    if (!off) {
      block.value = state.block;
      for (const option of block.options) option.hidden = !OFFERED_BLOCKS.has(option.value) && option.value !== state.block;
    }
    const pressed = {
      [FORMATS.BOLD]: state?.bold,
      [FORMATS.ITALIC]: state?.italic,
      [FORMATS.STRIKE]: state?.strike,
      [FORMATS.CODE]: state?.code,
      [FORMATS.LINK]: Boolean(state?.link),
      [FORMATS.BULLETS]: state?.list === 'ul' && !state?.task,
      [FORMATS.NUMBERED]: state?.list === 'ol',
      [FORMATS.TASKS]: Boolean(state?.task),
      [FORMATS.QUOTE]: state?.quote,
    };
    for (const [format, button] of buttons) {
      const disabled = off
        || (format === FORMATS.BOLD && (state.heading || state.headCell))
        || (state.cell && BLOCK_LEVEL.has(format));
      button.setAttribute('aria-pressed', String(Boolean(!off && pressed[format])));
      if (disabled) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
    currentLink = off ? null : state.link;
    if (active.disabled) setActive(controls()[0] ?? block);
  }

  applyLabels();
  setActive(block);
  render(null);

  return {
    element: bar,
    render,
    applyLabels,
    openLink: () => {
      if (buttons.get(FORMATS.LINK).getAttribute('aria-disabled') !== 'true') openLink(currentLink);
    },
    closeLink,
    /** The first control, for the keyboard's way from the document to the bar. */
    focus() {
      active.focus();
    },
  };
}
