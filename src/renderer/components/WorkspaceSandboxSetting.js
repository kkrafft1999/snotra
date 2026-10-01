import { createInstantStatus } from './InstantSetting.js';
import { describeWorkspaceSandbox } from '../utils/sandbox-status-view.js';
import { modeLabel } from '../utils/tool-approval-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { onLocaleChange, t, tMessage } from '../i18n.js';

/**
 * The sandbox switch for the open workspace in Settings › Tools (#357).
 *
 * The value lives in main's policy file, not in the settings draft: like the
 * permissions it takes effect at once. Switching it off is confirmed in a
 * native dialog by main; a cancelled dialog puts the switch back without a
 * word, a failed save says so. The root is always main's active one.
 */
export function initWorkspaceSandboxSetting({ toolPermissions, onChange = () => {} }) {
  const card = document.getElementById('settings-sandbox-card');
  const input = document.getElementById('input-workspace-sandbox');
  const rootEl = document.getElementById('settings-sandbox-workspace-name');
  const tile = document.getElementById('settings-sandbox-tile');
  const titleEl = document.getElementById('settings-sandbox-tile-title');
  const bodyEl = document.getElementById('settings-sandbox-tile-body');
  const stateEl = document.getElementById('settings-sandbox-state');
  const status = createInstantStatus(document.getElementById('status-workspace-sandbox'));
  if (!card || !input || !toolPermissions) {
    return { update() {}, isDisabledHere: () => false, focus: () => false };
  }

  let toolsOn = false;
  let sandbox = null;
  let busy = false;
  let error = '';

  function render() {
    const permissions = toolPermissions.get();
    const view = describeWorkspaceSandbox({ permissions, toolsOn, sandbox, autoLabel: modeLabel('auto') });
    card.hidden = !view.visible;
    if (rootEl) rootEl.textContent = view.rootLabel;
    if (!busy) input.checked = view.checked;
    input.disabled = !view.hasWorkspace;
    // While main decides, the switch is marked busy rather than disabled: a
    // disabled control loses the focus to the top of the window (CR-B14-07).
    if (busy) input.setAttribute('aria-disabled', 'true');
    else input.removeAttribute('aria-disabled');
    if (tile) tile.dataset.tone = view.tone;
    if (titleEl) titleEl.textContent = view.title;
    if (bodyEl) bodyEl.textContent = view.body;
    // The tile carries the state (#543); the line below it only a failed save.
    if (stateEl) {
      stateEl.hidden = !error;
      stateEl.textContent = error;
    }
  }

  // A switch that is busy takes no second press, by mouse or by Space.
  input.addEventListener('click', (event) => {
    if (input.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });

  input.addEventListener('change', async () => {
    if (busy) return;
    const enabled = input.checked;
    const hadFocus = document.activeElement === input;
    busy = true;
    error = '';
    status.clear();
    render();
    const result = await toolPermissions.setWorkspaceSandbox(enabled);
    busy = false;
    if (result?.ok) {
      status.saved();
    } else if (!isCancelledResult(result)) {
      error = tMessage(result?.error) || t('settings.instant.failed');
      status.failed();
    }
    // Whatever happened, the switch shows what main holds.
    render();
    onChange();
    // Nothing here moves the focus; should a redraw around it have dropped
    // it, the keyboard comes back to the switch it was on.
    const active = document.activeElement;
    if (hadFocus && input.isConnected && (!active || active === document.body)) input.focus();
  });

  toolPermissions.subscribe(() => {
    render();
    onChange();
  });
  onLocaleChange(render);

  return {
    /** What the settings know about the execution tools; redraws the card. */
    update(next = {}) {
      toolsOn = next.toolsOn === true;
      sandbox = next.sandbox && typeof next.sandbox === 'object' ? next.sandbox : null;
      error = '';
      status.clear();
      render();
    },
    isDisabledHere: () => toolPermissions.get()?.workspaceSandboxDisabled === true,
    /** Brings the switch into view for the card's "Sandbox setting" link. */
    focus() {
      if (card.hidden) return false;
      card.scrollIntoView({ block: 'center' });
      input.focus();
      return true;
    },
  };
}
