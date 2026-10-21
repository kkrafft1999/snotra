'use strict';

/**
 * The shortcut for developer mode (#1213): Cmd+Option+Shift+D on macOS,
 * Ctrl+Alt+Shift+D on Windows and Linux (decided 2026-10-21).
 *
 * Matched on `before-input-event` by the physical key (`code: 'KeyD'`), not
 * by the character: Option+Shift+D types `Î` on a Mac, and an accelerator
 * compares characters. Like the hidden-files shortcut, it works with the
 * focus anywhere in the window, and it has no menu entry — it is not for
 * every user.
 */

/**
 * @param {import('./hidden-files-shortcut').KeyInput | null | undefined} input
 * @param {string} [platform]
 */
function matchesDeveloperModeShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.code !== 'KeyD') return false;
  if (input.shift !== true || input.alt !== true) return false;
  return platform === 'darwin'
    ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true;
}

/**
 * A `before-input-event` listener that calls `onToggle` once per press.
 *
 * @param {{ platform?: string, onToggle: () => void }} options
 * @returns {(event: { preventDefault: () => void }, input: import('./hidden-files-shortcut').KeyInput) => void}
 */
function createDeveloperModeShortcutHandler({ platform = process.platform, onToggle }) {
  return (event, input) => {
    if (!matchesDeveloperModeShortcut(input, platform)) return;
    event.preventDefault();
    // Held down, the key repeats; the mode would flicker instead of flip.
    if (input.isAutoRepeat === true) return;
    onToggle();
  };
}

module.exports = { matchesDeveloperModeShortcut, createDeveloperModeShortcutHandler };
