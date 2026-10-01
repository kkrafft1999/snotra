import { createInstantStatus } from './InstantSetting.js';
import { toolModeOptions } from '../utils/tool-approval-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { onLocaleChange, t, tMessage } from '../i18n.js';

/**
 * The default mode of the open workspace in the header of Settings › Security
 * (#413, #448): what every new chat in this folder starts with. The same value
 * as the checkbox under the mode pill's menu.
 *
 * Like the sandbox switch further down the page, the value lives in main's
 * policy file and takes effect at once. "Auto" is confirmed in a native dialog
 * by main; a cancelled dialog puts the selection back without a word, a failed
 * save says so. The root is always main's active one; the page names the
 * folder itself.
 */
const IDS = Object.freeze({
  card: 'settings-security-header',
  group: 'settings-security-mode-options',
  state: 'settings-security-mode-state',
  status: 'status-security-mode',
  name: 'security-default-mode',
});

/** A failed save without a reason from main. */
const SAVE_FAILED = Object.freeze({ key: 'settings.instant.failed' });

export function initWorkspaceModeSetting({ toolPermissions }) {
  const card = document.getElementById(IDS.card);
  const group = document.getElementById(IDS.group);
  const stateEl = document.getElementById(IDS.state);
  const status = createInstantStatus(document.getElementById(IDS.status));
  if (!card || !group || !toolPermissions) return { render() {}, reset() {} };

  let busy = false;
  // A failed save, as main's message: put into words when drawn, and gone
  // once the attempt is over — on open, in another folder, in another
  // language (CR-B14-09).
  let error = null;
  let shownRoot = toolPermissions.get()?.workspaceRoot ?? null;

  function clearFailure() {
    error = null;
    status.clear();
  }

  function build() {
    group.innerHTML = '';
    for (const option of toolModeOptions()) {
      const label = document.createElement('label');
      label.className = 'settings-segmented__option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = IDS.name;
      input.value = option.value;
      const text = document.createElement('span');
      text.textContent = option.label;
      label.appendChild(input);
      label.appendChild(text);
      group.appendChild(label);
      // The `title` only reaches a mouse; the same sentence is the radio's
      // description, kept outside the label so it is not part of the name
      // (CR-B14-08). For a blocked "Auto" it is the reason.
      const desc = document.createElement('span');
      desc.id = `${IDS.name}-desc-${option.value}`;
      desc.hidden = true;
      input.setAttribute('aria-describedby', desc.id);
      group.appendChild(desc);
    }
  }

  function describeOptions(state, current) {
    for (const option of toolModeOptions(state, current)) {
      const input = group.querySelector(`input[value="${option.value}"]`);
      if (!input) continue;
      const label = input.closest('label');
      if (label) label.title = option.description;
      const desc = document.getElementById(input.getAttribute('aria-describedby'));
      if (desc) desc.textContent = option.description;
    }
  }

  function render() {
    const state = toolPermissions.get();
    // Main answers with an object, folder or not; null is a failed read, which
    // is not the same as "no folder" (CR-B14-09).
    const readable = !!state && typeof state === 'object';
    const root = typeof state?.workspaceRoot === 'string' ? state.workspaceRoot : '';
    const current = state?.workspaceMode || 'smart';
    // Without safeStorage "Auto" cannot be stored; one that is stored stays
    // selectable, so that it can be seen and taken back.
    const autoBlocked = state?.encryptionAvailable === false && current !== 'auto';
    describeOptions(state, current);
    for (const input of group.querySelectorAll('input')) {
      if (!busy) input.checked = !!root && input.value === current;
      input.disabled = busy || !root || (input.value === 'auto' && autoBlocked);
    }
    let text = error ? tMessage(error) || t('settings.instant.failed') : '';
    if (!text && !readable) text = t('settings.permissions.unreadable');
    else if (!text && !root) text = t('settings.workspaceMode.none');
    else if (!text && autoBlocked) text = t('settings.workspaceMode.needsEncryption');
    if (stateEl) {
      stateEl.hidden = !text;
      stateEl.textContent = text;
      stateEl.classList.toggle('error', !!error || !readable);
    }
  }

  group.addEventListener('change', async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.checked) return;
    busy = true;
    clearFailure();
    render();
    const result = await toolPermissions.setWorkspaceMode(input.value);
    busy = false;
    if (result?.ok) {
      status.saved();
    } else if (!isCancelledResult(result)) {
      error = result?.error || SAVE_FAILED;
      status.failed();
    }
    // Whatever happened, the selection shows what main holds.
    render();
    input.focus();
  });

  toolPermissions.subscribe(() => {
    // A failure in one folder says nothing about the next one.
    const root = toolPermissions.get()?.workspaceRoot ?? null;
    if (root !== shownRoot) {
      shownRoot = root;
      clearFailure();
    }
    render();
  });
  onLocaleChange(() => {
    clearFailure();
    build();
    render();
  });
  build();
  render();
  return {
    render,
    /** The page was opened: a failure from an earlier visit is over. */
    reset() {
      clearFailure();
      render();
    },
  };
}
