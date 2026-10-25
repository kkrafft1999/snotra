// The row of actions under a chat message (#1255). For now it holds one
// button, Copy, and next to it what already stood under the message: the
// turn's duration under an answer (#1254), "Sent from iPhone" under a
// question (#1197). Further actions — edit and resend, retry — go into the
// same row.
//
// Copy puts the message's source on the clipboard — the Markdown as the model
// wrote it, the question as it was typed — not the rendered text. It goes
// through main (`api.writeClipboardText`): the permission handler does not
// allow `navigator.clipboard` in the renderer.

import { t } from '../i18n.js';

/** How long the check mark stays on the button; a failure stays longer, to be read. */
export const COPY_DONE_MS = 2000;
export const COPY_FAILED_MS = 5000;

// The two glyphs of the copy button in the file info dialog, at 16 px.
const COPY_ICON_HTML = '<svg class="chat-msg-copy__icon" viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>'
  + '<path d="M10.5 3.5v-.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>';
const CHECK_ICON_HTML = '<svg class="chat-msg-copy__check" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M3 8.5l3 3 7-7"/></svg>';

/**
 * What Copy puts on the clipboard for a message, or null when it offers none:
 * the greeting is not part of the conversation, an answer still being written
 * is not finished, and a message of images alone has no text.
 * @param {{ content?: unknown, greeting?: boolean, streaming?: boolean }} message
 * @returns {string|null}
 */
export function copyTextOf(message) {
  if (!message || message.greeting || message.streaming) return null;
  const text = typeof message.content === 'string' ? message.content : '';
  return text.trim() ? text : null;
}

/**
 * The Copy button for one message.
 * @param {string} text what goes on the clipboard
 * @param {{
 *   writeClipboardText: (text: string) => Promise<{ ok?: boolean }|undefined>,
 *   announce?: (text: string) => void,
 * }} deps
 * @returns {HTMLButtonElement}
 */
export function buildCopyButton(text, { writeClipboardText, announce }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-msg-copy';
  button.insertAdjacentHTML('afterbegin', COPY_ICON_HTML + CHECK_ICON_HTML);
  // A failure is said in words next to the glyph, not by its tooltip alone.
  const note = document.createElement('span');
  note.className = 'chat-msg-copy__note';
  note.setAttribute('aria-hidden', 'true');
  button.appendChild(note);
  let timer = 0;

  /** @param {null|'done'|'failed'} state */
  function show(state) {
    button.classList.toggle('chat-msg-copy--done', state === 'done');
    button.classList.toggle('chat-msg-copy--failed', state === 'failed');
    const key = state === 'done' ? 'chat.copy.done' : state === 'failed' ? 'chat.copy.failed' : 'chat.copy.label';
    button.setAttribute('aria-label', t(key));
    button.title = t(key);
    note.textContent = state === 'failed' ? t('chat.copy.failedShort') : '';
  }

  button.addEventListener('click', async () => {
    let ok = false;
    try {
      const result = await writeClipboardText(text);
      ok = result?.ok !== false;
    } catch {
      // A write that threw is a failed copy like one main refused: the
      // button and the announcer below say so to the user.
      ok = false;
    }
    clearTimeout(timer);
    show(ok ? 'done' : 'failed');
    announce?.(t(ok ? 'chat.copy.done' : 'chat.copy.failed'));
    timer = setTimeout(() => show(null), ok ? COPY_DONE_MS : COPY_FAILED_MS);
  });

  show(null);
  return button;
}

/**
 * The row under a message, or null when it would be empty.
 * @param {(Node|null|undefined)[]} items in order, empty slots skipped
 * @returns {HTMLElement|null}
 */
export function buildMessageActions(items) {
  const present = items.filter(Boolean);
  if (present.length === 0) return null;
  const row = document.createElement('div');
  row.className = 'chat-msg-actions';
  row.append(.../** @type {Node[]} */ (present));
  return row;
}
