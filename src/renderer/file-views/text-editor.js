// The text editor of the file preview (#863).
//
// One small interface, so that the `<textarea>` here can be replaced by
// CodeMirror (#864) without touching anything around it. Everything outside
// this module — autosave, the save state, conflicts, the edit toggle, the lock
// while the agent works — talks to the object `mountTextEditor` returns and
// never to the element: no `value`, no `selectionStart`, no DOM events on it.
//
//   mountTextEditor(hostEl, { text, language, label, onChange, onBlur, onCommand })
//     → { getText(), setText(text, { keepSelection }), focus(),
//         viewState(), restoreViewState(state), setReadOnly(bool),
//         setLabel(text), destroy() }
//
//   * `onChange()` runs after every change the user makes — CodeMirror
//     reports transactions, not `input` events, so nobody outside listens to
//     the element.
//   * Undo and redo belong to the editor: here the textarea's own history.
//   * Line endings: the editor works in `\n` — a textarea turns every `\r\n`
//     into `\n`, and so does CodeMirror. A file that had `\r\n` gets them back
//     in `getText()`; one with mixed endings comes back with `\r\n` throughout
//     once it is edited. Text nobody touched comes back exactly as it was
//     given, so that opening and leaving the editor never changes a file.
//   * The look lives in `.text-editor` in styles.css, on the same design
//     tokens as the read-only view, so a CodeMirror theme can be derived from
//     them.

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent ?? '');

/**
 * Every key the editor claims, in one place, so that a collision with an app
 * shortcut shows here — and once CodeMirror brings its own keymap. Tab is
 * deliberately not claimed: it moves the focus on, as everywhere else in the
 * app, so that the keyboard can always leave the text.
 */
export const EDITOR_SHORTCUTS = Object.freeze([
  Object.freeze({ keys: 'Mod+S', command: 'save' }),
  Object.freeze({ keys: 'Escape', command: 'leave' }),
]);

function matches(event, keys) {
  const parts = keys.split('+');
  const key = parts.pop();
  const wantsMod = parts.includes('Mod');
  const mod = isMac() ? event.metaKey : event.ctrlKey;
  if (wantsMod !== mod || event.altKey || event.shiftKey) return false;
  return key.length === 1 ? event.key.toLowerCase() === key.toLowerCase() : event.key === key;
}

/** The line ending a file is written with; `\r\n` once it has any. */
function lineEndingOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

const toLf = (text) => text.replace(/\r\n?/g, '\n');

export function mountTextEditor(hostEl, {
  text = '',
  language = null,
  label = '',
  onChange = () => {},
  onBlur = () => {},
  onCommand = () => {},
} = {}) {
  const area = document.createElement('textarea');
  area.className = 'text-editor';
  area.spellcheck = false;
  area.setAttribute('autocomplete', 'off');
  area.setAttribute('autocapitalize', 'off');
  area.setAttribute('wrap', 'off');
  area.setAttribute('aria-keyshortcuts', EDITOR_SHORTCUTS
    .map(({ keys }) => keys.replace('Mod', isMac() ? 'Meta' : 'Control'))
    .join(' '));
  if (language) area.dataset.language = language;
  if (label) area.setAttribute('aria-label', label);
  let lineEnding = '\n';
  // The text as it was given, and as the textarea holds it.
  let pristine = { text: '', lf: '' };
  function load(next) {
    lineEnding = lineEndingOf(next);
    pristine = { text: next, lf: toLf(next) };
    area.value = pristine.lf;
  }
  load(text);
  hostEl.append(area);

  const handleInput = () => onChange();
  const handleBlur = () => onBlur();
  function handleKeyDown(event) {
    if (event.isComposing) return;
    const shortcut = EDITOR_SHORTCUTS.find(({ keys }) => matches(event, keys));
    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();
    onCommand(shortcut.command);
  }
  area.addEventListener('input', handleInput);
  area.addEventListener('blur', handleBlur);
  area.addEventListener('keydown', handleKeyDown);

  return {
    getText() {
      const { value } = area;
      if (value === pristine.lf) return pristine.text;
      return lineEnding === '\n' ? value : value.replace(/\n/g, lineEnding);
    },
    /**
     * Replaces the whole text — the file changed on disk and nothing of the
     * user's is lost by it. With `keepSelection`, cursor and scroll stay where
     * they were, as far as the new text reaches.
     */
    setText(next, { keepSelection = false } = {}) {
      const { selectionStart, selectionEnd, scrollTop, scrollLeft } = area;
      load(next);
      if (!keepSelection) return;
      const end = area.value.length;
      area.setSelectionRange(Math.min(selectionStart, end), Math.min(selectionEnd, end));
      area.scrollTop = scrollTop;
      area.scrollLeft = scrollLeft;
    },
    focus() {
      area.focus({ preventScroll: true });
    },
    viewState() {
      return { top: area.scrollTop, left: area.scrollLeft, start: area.selectionStart, end: area.selectionEnd };
    },
    restoreViewState(state) {
      if (!state) return;
      const end = area.value.length;
      if (Number.isFinite(state.start)) {
        area.setSelectionRange(Math.min(state.start, end), Math.min(state.end ?? state.start, end));
      }
      area.scrollTop = Number(state.top) || 0;
      area.scrollLeft = Number(state.left) || 0;
    },
    setReadOnly(readOnly) {
      area.readOnly = Boolean(readOnly);
    },
    setLabel(next) {
      area.setAttribute('aria-label', next);
    },
    destroy() {
      area.removeEventListener('input', handleInput);
      area.removeEventListener('blur', handleBlur);
      area.removeEventListener('keydown', handleKeyDown);
      area.remove();
    },
  };
}
