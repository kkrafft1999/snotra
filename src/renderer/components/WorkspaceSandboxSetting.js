import { createInstantStatus } from './InstantSetting.js';
import { describeWorkspaceSandbox } from '../utils/sandbox-status-view.js';
import { modeLabel } from '../utils/tool-approval-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { onLocaleChange, t, tMessage } from '../i18n.js';

/** A failed save without a reason from main. */
const SAVE_FAILED = Object.freeze({ key: 'settings.instant.failed' });

/**
 * The sandbox switch for the open workspace on Settings › Security (#357,
 * #449).
 *
 * The value lives in main's policy file, not in the settings draft: like the
 * permissions it takes effect at once. Switching it off is confirmed in a
 * native dialog by main; a cancelled dialog puts the switch back without a
 * word, a failed save says so. The root is always main's active one. Without
 * encrypted storage "off" cannot be stored and is not offered (CR-B14-09);
 * main refuses it anyway.
 */
export function initWorkspaceSandboxSetting({ toolPermissions, onChange = () => {} }) {
  const card = document.getElementById('settings-sandbox-card');
  const input = document.getElementById('input-workspace-sandbox');
  const rootEl = document.getElementById('settings-sandbox-workspace-name');
  const tile = document.getElementById('settings-sandbox-tile');
  const titleEl = document.getElementById('settings-sandbox-tile-title');
  const bodyEl = document.getElementById('settings-sandbox-tile-body');
  const noteEl = document.getElementById('settings-sandbox-tile-note');
  const stateEl = document.getElementById('settings-sandbox-state');
  const status = createInstantStatus(document.getElementById('status-workspace-sandbox'));
  if (!card || !input || !toolPermissions) {
    return { update() {}, reset() {}, isDisabledHere: () => false, focus: () => false };
  }

  let toolsOn = false;
  let sandbox = null;
  let busy = false;
  // A failed save, as main's message: put into words when drawn, and gone
  // once the attempt is over — on open, in another folder, in another
  // language (CR-B14-09).
  let error = null;
  let shownRoot = toolPermissions.get()?.workspaceRoot ?? null;

  // Only a failure is cleared, never a fresh "Saved": that one fades by
  // itself, and clearing it would take back what the user just did.
  function clearFailure() {
    if (!error) return;
    error = null;
    status.clear();
  }

  /**
   * A failure in one folder says nothing about the next one. Only a state
   * that could be read names a folder: a failed read in between (`null`,
   * e.g. while main writes the policy file on Windows) is not a move.
   */
  function noteFolder() {
    const state = toolPermissions.get();
    if (!state || typeof state !== 'object') return;
    const root = state.workspaceRoot ?? null;
    if (root === shownRoot) return;
    shownRoot = root;
    clearFailure();
  }

  function render() {
    const permissions = toolPermissions.get();
    const view = describeWorkspaceSandbox({ permissions, toolsOn, sandbox, autoLabel: modeLabel('auto') });
    card.hidden = !view.visible;
    if (rootEl) {
      rootEl.textContent = view.rootLabel;
      // Cut with an ellipsis next to the heading's help link (#848).
      rootEl.title = view.rootLabel ?? '';
    }
    if (!busy) input.checked = view.checked;
    input.disabled = !view.hasWorkspace;
    // Busy while main decides, or "off" not offered: marked rather than
    // disabled. A disabled control loses the focus to the top of the window
    // (CR-B14-07), and one that cannot be reached hides its reason.
    if (busy || (view.offBlocked && view.checked)) input.setAttribute('aria-disabled', 'true');
    else input.removeAttribute('aria-disabled');
    if (tile) tile.dataset.tone = view.tone;
    if (titleEl) titleEl.textContent = view.title;
    if (bodyEl) bodyEl.textContent = view.body;
    if (noteEl) noteEl.textContent = view.note;
    // The tile carries the state (#543); the line below it only a failed save.
    if (stateEl) {
      const text = error ? tMessage(error) || t('settings.instant.failed') : '';
      stateEl.hidden = !text;
      stateEl.textContent = text;
    }
  }

  // A switch that is marked takes no press, by mouse or by Space.
  input.addEventListener('click', (event) => {
    if (input.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });

  input.addEventListener('change', async () => {
    if (input.getAttribute('aria-disabled') === 'true') {
      // Only code gets here past the click guard; the flip does not count.
      input.checked = !input.checked;
      return;
    }
    const enabled = input.checked;
    const hadFocus = document.activeElement === input;
    busy = true;
    clearFailure();
    render();
    const result = await toolPermissions.setWorkspaceSandbox(enabled);
    busy = false;
    if (result?.ok) {
      status.saved();
    } else if (!isCancelledResult(result)) {
      error = result?.error || SAVE_FAILED;
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
    noteFolder();
    render();
    onChange();
  });
  onLocaleChange(() => {
    // Every status goes here, a "Saved" included: it would stay in the
    // language it was written in.
    error = null;
    status.clear();
    render();
  });

  return {
    /**
     * What the settings know about the execution tools; redraws the card.
     * It runs whenever their state is read again, so it leaves the status
     * alone — a failure ends with `reset()`.
     */
    update(next = {}) {
      toolsOn = next.toolsOn === true;
      sandbox = next.sandbox && typeof next.sandbox === 'object' ? next.sandbox : null;
      render();
    },
    /** Settings was closed: a failure from this visit is over. */
    reset() {
      clearFailure();
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
