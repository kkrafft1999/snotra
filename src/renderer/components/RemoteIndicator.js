/**
 * The paired phone in the title bar, while it is connected (#1196, R8 of the
 * mobile remote #1081): whoever sits at the desktop sees at a glance that the
 * chats can be followed and driven from a phone, and gets in one click to
 * where the phone is removed.
 *
 * Main decides what *connected* means — a standing session with a fresh
 * heartbeat, held a little longer so a reconnect does not flicker — and
 * whether the computer is kept awake for a working run; this only draws it.
 * A change is said once to a screen reader, never a heartbeat.
 */
import { t, onLocaleChange } from '../i18n.js';

/**
 * @param {{
 *   api: any,
 *   openSettings: () => void,
 *   button?: HTMLElement | null,
 *   awake?: HTMLElement | null,
 *   status?: HTMLElement | null,
 * }} deps
 */
export function initRemoteIndicator({
  api,
  openSettings,
  button = document.getElementById('titlebar-remote'),
  awake = document.getElementById('titlebar-remote-awake'),
  status = document.getElementById('titlebar-remote-status'),
}) {
  if (!button || !api?.remote || typeof api.remote.getPresence !== 'function') return null;

  let state = { connected: false, keepingAwake: false };
  /** Until the first answer nothing is announced: a phone already there is no news. */
  let known = false;

  function draw() {
    button.hidden = !state.connected;
    if (awake) awake.hidden = !state.keepingAwake;
    // The name is the visible text (WCAG 2.5.3); what a click does is its description.
    button.title = t(state.keepingAwake ? 'titlebar.remote.hintAwake' : 'titlebar.remote.hint');
  }

  /** @param {unknown} next */
  function apply(next) {
    const raw = /** @type {{ connected?: unknown, keepingAwake?: unknown } | null} */ (next);
    const connected = raw?.connected === true;
    const keepingAwake = connected && raw?.keepingAwake === true;
    const changed = connected !== state.connected;
    state = { connected, keepingAwake };
    draw();
    if (known && changed && status) {
      status.textContent = t(connected ? 'titlebar.remote.announceConnected' : 'titlebar.remote.announceDisconnected');
    }
    known = true;
  }

  button.addEventListener('click', () => openSettings());
  api.remote.onPresence?.(apply);
  onLocaleChange(draw);
  api.remote.getPresence().then(apply, (/** @type {unknown} */ error) => {
    console.error('[remote] the phone\'s presence could not be read:', error);
    known = true;
  });

  return { getState: () => ({ ...state }) };
}
