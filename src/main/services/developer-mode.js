'use strict';

/**
 * Developer mode (#1213): switched with ⌘⌥⇧D (Ctrl+Alt+Shift+D elsewhere),
 * kept in the UI preferences until switched off (decided 2026-10-21). It
 * shows *Settings › Remote access* and opens pairing a phone — for building
 * the phone's side against a real desktop. Every pairing still needs the
 * native *Allow*.
 *
 * Only this service writes the preference; the settings' generic patch does
 * not carry it.
 */

/**
 * @param {{
 *   uiPrefsStore: Pick<import('../ports/ui-prefs-store-port').UiPrefsStorePort, 'readUIPrefs' | 'updateUIPrefs'>,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps
 */
function createDeveloperMode({ uiPrefsStore, log = console }) {
  let on = false;
  /** @type {Set<(on: boolean, how: 'loaded' | 'switched') => void>} */
  const listeners = new Set();

  /** @param {'loaded' | 'switched'} how  a notice is due only when the user switched it */
  function tell(how) {
    for (const listener of listeners) {
      try {
        listener(on, how);
      } catch (error) {
        log.warn(`[developer-mode] a listener failed (${error?.name || 'error'})`);
      }
    }
  }

  return {
    /** Reads the stored mode; until then it is off. */
    async load() {
      try {
        on = (await uiPrefsStore.readUIPrefs()).developerMode === true;
      } catch (error) {
        log.warn(`[developer-mode] the preference could not be read (${error?.name || 'error'})`);
        on = false;
      }
      // Off is what everyone starts from: only a stored "on" changes anything.
      if (on) tell('loaded');
      return on;
    },
    isOn: () => on,
    /** Switches the mode and keeps it; resolves to the new state. */
    async toggle() {
      const next = !on;
      await uiPrefsStore.updateUIPrefs((prefs) => ({ ...prefs, developerMode: next }));
      on = next;
      tell('switched');
      return on;
    },
    /** @param {(on: boolean, how: 'loaded' | 'switched') => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

module.exports = { createDeveloperMode };
