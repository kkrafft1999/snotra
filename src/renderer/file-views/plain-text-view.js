// The default view: a text file as it is, character for character (#225).
//
// It takes every file `isTextFile` recognises and nobody further up in the
// registry claims. The interface it implements is documented in the header of
// `registry.js`.
//
// Source text is coloured by its file name (#745, syntax-language.js). The
// colours are spans around the same characters: selecting and copying still
// gives the file as it is. A file up to COLOUR_AT_ONCE_LIMIT is shown coloured
// right away; a larger one first as plain text and coloured once the pane has
// been drawn, so that opening it never waits on the highlighter; beyond
// COLOUR_LIMIT it stays plain.
//
// Editing (#863): an *Edit* toggle in the header puts the text editor
// (`text-editor.js`) in place of the coloured text, with autosave
// (`autosave.js`) and the save state next to the toggle. The read-only view
// stays the default. Writes go through the host (`context.writeFile`), so that
// the host knows what is on disk afterwards. A view that mounts this one for a
// source of its own — the SVG source of the image view — passes
// `editable: false`; the Markdown source passes a context of its own that
// collects the tools and the saved text (`markdown-view.js`).

import { t, onLocaleChange } from '../i18n.js';
import { isTextFile } from '../utils/helpers.js';
import { syntaxLanguageFor } from './syntax-language.js';
import { highlightToFragment } from './syntax-highlight.js';
import { mountTextEditor } from './text-editor.js';
import { SAVE_STATES, createAutosave } from './autosave.js';
import { createEditControls } from './edit-controls.js';

export const COLOUR_AT_ONCE_LIMIT = 64 * 1024;
export const COLOUR_LIMIT = 512 * 1024;

/** After the next frame has been drawn — not merely before it. */
function afterPaint(fn) {
  let timer = 0;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(fn, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

export const plainTextView = {
  id: 'plain-text',
  kind: 'editor',

  canHandle({ name }) {
    return isTextFile(name);
  },

  mount(hostEl, context) {
    const { content, file, viewState = null } = context;
    const pre = document.createElement('pre');
    pre.id = 'preview-content';
    const language = syntaxLanguageFor(file?.name);
    if (language) pre.dataset.language = language;
    hostEl.append(pre);

    let cancelPending = () => {};
    // The text on disk as this view last knew it.
    let text = content ?? '';
    const editable = context.editable !== false && typeof context.writeFile === 'function';
    let blocked = Boolean(context.isEditingBlocked?.());
    // While editing: { container, notice, editor, autosave }.
    let edit = null;
    let disposed = false;

    // Same node, new children: the scroll position is carried over by hand,
    // which is what a reload of the same file wants.
    function replace(fragmentOrText) {
      const { scrollTop, scrollLeft } = pre;
      if (typeof fragmentOrText === 'string') pre.textContent = fragmentOrText;
      else pre.replaceChildren(fragmentOrText);
      pre.scrollTop = scrollTop;
      pre.scrollLeft = scrollLeft;
    }

    function show(next) {
      cancelPending();
      cancelPending = () => {};
      const colourable = !!language && next.length <= COLOUR_LIMIT;
      const atOnce = colourable && next.length <= COLOUR_AT_ONCE_LIMIT ? highlightToFragment(next, language) : null;
      replace(atOnce ?? next);
      pre.dataset.highlighted = String(!!atOnce);
      if (atOnce || !colourable || next.length <= COLOUR_AT_ONCE_LIMIT) return;
      cancelPending = afterPaint(() => {
        const fragment = highlightToFragment(next, language);
        if (!fragment) return;
        replace(fragment);
        pre.dataset.highlighted = 'true';
      });
    }

    // ── Edit toggle and save state in the header (#863) ───────────────────

    const controls = createEditControls({
      onToggle: () => {
        if (edit) void leaveEditing({ focusToggle: true });
        else enterEditing();
      },
      onPrimary: () => void onPrimary(),
      onSecondary: () => void onSecondary(),
    });
    const { toggle, status } = controls;

    /** A text the preview decoded with replacement characters is not UTF-8. */
    const isUtf8 = () => !text.includes('�');

    /** Why the toggle cannot be used right now, as a catalogue key, or null. */
    function lockReason() {
      if (blocked) return 'fileView.edit.blocked';
      if (!edit && !isUtf8()) return 'fileView.edit.notText';
      return null;
    }

    function renderEditState() {
      controls.render({
        editing: Boolean(edit),
        lockReason: lockReason(),
        save: edit?.autosave.state ?? null,
        blocked,
      });
    }

    function onSaveState() {
      if (!edit) return;
      context.setDirty?.(edit.autosave.isDirty());
      renderEditState();
    }

    async function onPrimary() {
      if (!edit || blocked) return;
      const ok = edit.autosave.state.status === SAVE_STATES.CONFLICT
        ? await edit.autosave.keepMine()
        : await edit.autosave.flush();
      if (ok) edit?.editor.focus();
    }

    async function onSecondary() {
      if (!edit || blocked) return;
      const { status: saveStatus, conflict } = edit.autosave.state;
      await takeDiskVersion({ leave: saveStatus === SAVE_STATES.FAILED || conflict === 'deleted' });
    }

    /**
     * The user gives up their text for the one on disk. With `leave`, or when
     * the file cannot be read any more, editing ends; otherwise it goes on
     * from the disk's text.
     */
    async function takeDiskVersion({ leave }) {
      const result = await context.readFile?.();
      if (!edit || disposed) return;
      const read = Boolean(result && !result.error && typeof result.content === 'string');
      if (read) text = result.content;
      edit.autosave.adopt(text);
      if (leave || !read) {
        closeEditor({ focusToggle: true });
        return;
      }
      edit.editor.setText(text, { keepSelection: true });
      context.setDirty?.(false);
      renderEditState();
      edit.editor.focus();
    }

    function onEditorCommand(command) {
      if (!edit) return;
      if (command === 'save') void edit.autosave.flush();
      else if (command === 'leave') void leaveEditing({ focusToggle: true });
    }

    function enterEditing() {
      if (edit || disposed || !editable || lockReason()) return;
      const scroll = { top: pre.scrollTop, left: pre.scrollLeft };
      const container = document.createElement('div');
      container.className = 'file-edit';
      const area = document.createElement('div');
      area.className = 'file-edit__area';
      container.append(controls.notice, area);
      const editor = mountTextEditor(area, {
        text,
        language,
        label: t('fileView.edit.label', { name: file?.name ?? '' }),
        onChange: () => edit?.autosave.changed(),
        onBlur: () => void edit?.autosave.flush(),
        onCommand: onEditorCommand,
      });
      const autosave = createAutosave({
        base: text,
        getText: () => editor.getText(),
        write: (next, options) => context.writeFile(next, options),
        onState: onSaveState,
      });
      edit = { container, editor, autosave };
      pre.hidden = true;
      hostEl.append(container);
      editor.restoreViewState(scroll);
      editor.focus();
      renderEditState();
    }

    /** Back to the read-only view, without saving: whatever was to keep is kept. */
    function closeEditor({ focusToggle = false } = {}) {
      if (!edit) return;
      const scroll = edit.editor.viewState();
      edit.autosave.dispose();
      edit.editor.destroy();
      edit.container.remove();
      edit = null;
      pre.hidden = false;
      show(text);
      pre.scrollTop = scroll.top;
      pre.scrollLeft = scroll.left;
      context.setDirty?.(false);
      renderEditState();
      if (focusToggle && toggle.isConnected) toggle.focus();
    }

    /**
     * Saves and ends editing. False when the text could not be saved — then
     * the editor stays, and the bar above it says why.
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
      text = session.editor.getText();
      closeEditor({ focusToggle });
      return true;
    }

    show(text);
    // Back to where the reader was (#822).
    if (viewState) {
      pre.scrollTop = Number(viewState.top) || 0;
      pre.scrollLeft = Number(viewState.left) || 0;
    }
    if (editable) {
      renderEditState();
      context.setTools?.([toggle, status]);
    }

    const stopFollowingLocale = editable
      ? onLocaleChange(() => {
        renderEditState();
        edit?.editor.setLabel(t('fileView.edit.label', { name: file?.name ?? '' }));
      })
      : () => {};

    return {
      update({ content: next }) {
        const incoming = next ?? '';
        if (!edit) {
          text = incoming;
          show(text);
          if (editable) renderEditState();
          return;
        }
        // Never under the cursor: only text that loses nothing of the user's
        // is taken, anything else is a conflict for the user to settle.
        const answer = edit.autosave.external(incoming);
        if (answer === 'replace') {
          text = incoming;
          edit.editor.setText(incoming, { keepSelection: true });
        } else if (answer === 'ignore' && !edit.autosave.isDirty()) {
          text = incoming;
        }
      },
      /** Saves what the editor holds; true when nothing is left unsaved. */
      async save() {
        if (!edit) return true;
        return (await edit.autosave.flush()) && !edit.autosave.isDirty();
      },
      /** A chat run started or ended (#863): no editing while the agent works. */
      setEditingBlocked(next) {
        blocked = Boolean(next);
        if (!editable) return;
        edit?.editor.setReadOnly(blocked);
        renderEditState();
        if (blocked && edit) void leaveEditing();
      },
      /** Is the editor on show? */
      get editing() {
        return Boolean(edit);
      },
      leaveEditing,
      /** Where the reader is, for the way back (#822). */
      viewState() {
        if (edit) {
          const { top, left } = edit.editor.viewState();
          return { top, left };
        }
        return { top: pre.scrollTop, left: pre.scrollLeft };
      },
      unmount() {
        disposed = true;
        cancelPending();
        stopFollowingLocale();
        if (edit) {
          edit.autosave.dispose();
          edit.editor.destroy();
          edit = null;
        }
      },
    };
  },
};
