// What every editor of the file preview shows around its text (#863): the
// Edit toggle and the save state in the header, and the bar for a save that
// failed or a file that changed on disk under the user's changes.
//
// Shared by the source editor of the plain-text view and, since #1422, by
// editing in the Markdown preview, so that both look, read and behave alike.
// The controls only show a state; the editor decides what a click means.

import { t } from '../i18n.js';
import { SAVE_STATES } from './autosave.js';

const PENCIL_ICON = 'M10.8 2.7a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2L6 12.5l-3 .8.8-3z';

const FAILURE_KEYS = Object.freeze({
  'too-large': 'fileView.edit.reason.tooLarge',
  encoding: 'fileView.edit.reason.encoding',
  'not-file': 'fileView.edit.reason.notFile',
  refused: 'fileView.edit.reason.refused',
  permission: 'fileView.edit.reason.permission',
  missing: 'fileView.edit.reason.missing',
});

const STATUS_KEYS = Object.freeze({
  [SAVE_STATES.PENDING]: 'fileView.edit.state.saving',
  [SAVE_STATES.SAVING]: 'fileView.edit.state.saving',
  [SAVE_STATES.SAVED]: 'fileView.edit.state.saved',
  [SAVE_STATES.FAILED]: 'fileView.edit.state.failed',
  [SAVE_STATES.CONFLICT]: 'fileView.edit.state.conflict',
});

function pencilIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', PENCIL_ICON);
  svg.append(shape);
  return svg;
}

function actionButton(onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary file-edit-notice__action';
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Builds the controls. `onToggle()` runs on a click of the toggle that is not
 * locked; `onPrimary()` / `onSecondary()` on the two buttons of the bar —
 * retry or keep mine, and discard or take the disk's version.
 *
 * `render({ editing, lockReason, save, blocked })` shows a state: `editing`
 * whether the editor is on, `lockReason` a catalogue key that says why the
 * toggle cannot be used (or null), `save` the autosave's state while editing.
 */
export function createEditControls({ onToggle, onPrimary, onSecondary }) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'file-edit-toggle';
  toggle.setAttribute('aria-pressed', 'false');
  const toggleText = document.createElement('span');
  toggle.append(pencilIcon(), toggleText);
  toggle.addEventListener('click', () => {
    if (toggle.getAttribute('aria-disabled') === 'true') return;
    onToggle();
  });

  const status = document.createElement('span');
  status.className = 'file-edit-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const notice = document.createElement('div');
  notice.className = 'file-edit-notice';
  notice.setAttribute('role', 'alert');
  notice.hidden = true;
  const message = document.createElement('p');
  message.className = 'file-edit-notice__message';
  const actions = document.createElement('div');
  actions.className = 'file-edit-notice__actions';
  const primary = actionButton(() => onPrimary());
  const secondary = actionButton(() => onSecondary());
  actions.append(primary, secondary);
  notice.append(message, actions);

  function renderToggle(editing, lockReason) {
    toggleText.textContent = t('fileView.edit.toggle');
    toggle.setAttribute('aria-pressed', String(Boolean(editing)));
    // aria-disabled rather than disabled: the button stays focusable and
    // its tooltip says why it does nothing.
    if (lockReason) toggle.setAttribute('aria-disabled', 'true');
    else toggle.removeAttribute('aria-disabled');
    toggle.title = t(lockReason ?? (editing ? 'fileView.edit.toggle.leave' : 'fileView.edit.toggle.title'));
  }

  function renderStatus(editing, save) {
    const key = editing && save ? STATUS_KEYS[save.status] : null;
    status.hidden = !key;
    status.textContent = key ? t(key) : '';
    status.dataset.state = editing && save ? save.status : '';
  }

  function renderNotice(editing, save, blocked) {
    if (!editing || !save || (save.status !== SAVE_STATES.FAILED && save.status !== SAVE_STATES.CONFLICT)) {
      notice.hidden = true;
      return;
    }
    const { status: saveStatus, reason, conflict } = save;
    notice.hidden = false;
    notice.dataset.kind = saveStatus === SAVE_STATES.FAILED ? 'failed' : conflict;
    if (saveStatus === SAVE_STATES.FAILED) {
      message.textContent = t('fileView.edit.failed', { reason: t(FAILURE_KEYS[reason] ?? 'fileView.edit.reason.failed') });
      primary.textContent = t('fileView.edit.retry');
      secondary.textContent = t('fileView.edit.discard');
    } else {
      message.textContent = t(conflict === 'deleted' ? 'fileView.edit.conflict.deleted' : 'fileView.edit.conflict.changed');
      primary.textContent = t('fileView.edit.keepMine');
      secondary.textContent = t(conflict === 'deleted' ? 'fileView.edit.discard' : 'fileView.edit.takeDisk');
    }
    primary.disabled = blocked;
    secondary.disabled = blocked;
  }

  return {
    toggle,
    status,
    notice,
    render({ editing = false, lockReason = null, save = null, blocked = false } = {}) {
      renderToggle(editing, lockReason);
      renderStatus(editing, save);
      renderNotice(editing, save, blocked);
    },
  };
}
