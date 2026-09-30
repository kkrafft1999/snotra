import { createInstantStatus } from './InstantSetting.js';
import { toolModeOptions } from '../utils/tool-approval-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { onLocaleChange, t, tMessage } from '../i18n.js';

/**
 * The default mode of the open workspace in Settings › Permissions (#413): what
 * every new chat in this folder starts with. The same value as the checkbox
 * under the mode pill's menu.
 *
 * Like the sandbox switch next to it, the value lives in main's policy file
 * and takes effect at once. "Auto" is confirmed in a native dialog by main; a
 * cancelled dialog puts the selection back without a word, a failed save says
 * so. The root is always main's active one.
 */
const PERMISSIONS_IDS = Object.freeze({
  card: 'settings-workspace-mode-card',
  group: 'settings-workspace-mode-options',
  root: 'settings-workspace-mode-name',
  state: 'settings-workspace-mode-state',
  status: 'status-workspace-mode',
  name: 'workspace-default-mode',
});

/**
 * Settings › Security shows the same control in its header (#448): the same
 * value, a second set of elements. `ids.root` may be null there, the page
 * names the folder itself.
 */
export const SECURITY_PAGE_IDS = Object.freeze({
  card: 'settings-security-header',
  group: 'settings-security-mode-options',
  root: null,
  state: 'settings-security-mode-state',
  status: 'status-security-mode',
  name: 'security-default-mode',
});

export function initWorkspaceModeSetting({ toolPermissions, ids = PERMISSIONS_IDS }) {
  const card = document.getElementById(ids.card);
  const group = document.getElementById(ids.group);
  const rootEl = ids.root ? document.getElementById(ids.root) : null;
  const stateEl = document.getElementById(ids.state);
  const status = createInstantStatus(document.getElementById(ids.status));
  if (!card || !group || !toolPermissions) return { render() {} };

  let busy = false;
  let error = '';

  function build() {
    group.innerHTML = '';
    for (const option of toolModeOptions()) {
      const label = document.createElement('label');
      label.className = 'settings-segmented__option';
      label.title = option.description;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = ids.name;
      input.value = option.value;
      const text = document.createElement('span');
      text.textContent = option.label;
      label.appendChild(input);
      label.appendChild(text);
      group.appendChild(label);
    }
  }

  function render() {
    const state = toolPermissions.get();
    const root = typeof state?.workspaceRoot === 'string' ? state.workspaceRoot : '';
    const current = state?.workspaceMode || 'smart';
    // Without safeStorage "Auto" cannot be stored; one that is stored stays
    // selectable, so that it can be seen and taken back.
    const autoBlocked = state?.encryptionAvailable === false && current !== 'auto';
    if (rootEl) rootEl.textContent = root || t('settings.rules.workspace.none');
    for (const input of group.querySelectorAll('input')) {
      if (!busy) input.checked = !!root && input.value === current;
      input.disabled = busy || !root || (input.value === 'auto' && autoBlocked);
    }
    let text = error;
    if (!text && !root) text = t('settings.workspaceMode.none');
    else if (!text && autoBlocked) text = t('settings.workspaceMode.needsEncryption');
    if (stateEl) {
      stateEl.hidden = !text;
      stateEl.textContent = text;
      stateEl.classList.toggle('error', !!error);
    }
  }

  group.addEventListener('change', async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.checked) return;
    busy = true;
    error = '';
    status.clear();
    render();
    const result = await toolPermissions.setWorkspaceMode(input.value);
    busy = false;
    if (result?.ok) {
      status.saved();
    } else if (!isCancelledResult(result)) {
      error = tMessage(result?.error) || t('settings.instant.failed');
      status.failed();
    }
    // Whatever happened, the selection shows what main holds.
    render();
    input.focus();
  });

  toolPermissions.subscribe(render);
  onLocaleChange(() => {
    build();
    render();
  });
  build();
  render();
  return { render };
}
