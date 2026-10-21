'use strict';

/**
 * The shortcut for hidden files in the tree (#436): Cmd+Shift+. on macOS, the
 * Finder's own, and Ctrl+Shift+. on Windows and Linux.
 *
 * Matched on `before-input-event` by the physical key (`code: 'Period'`), not
 * by the character. Shift+. types a colon on a German keyboard, and a menu
 * accelerator compares characters — so it would miss there, on every platform.
 * The View menu therefore only shows the accelerator. Preventing the event
 * also keeps the menu's key equivalent on macOS from firing a second time on a
 * US keyboard, where it would match.
 */

/**
 * The part of Electron's `Input` the shortcut looks at.
 * @typedef {{ type?: string, code?: string, shift?: boolean, alt?: boolean, meta?: boolean, control?: boolean, isAutoRepeat?: boolean }} KeyInput
 */

/**
 * @param {KeyInput | null | undefined} input
 * @param {string} [platform]
 */
function matchesHiddenFilesShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.code !== 'Period') return false;
  if (input.shift !== true || input.alt === true) return false;
  return platform === 'darwin'
    ? input.meta === true && input.control !== true
    : input.control === true && input.meta !== true;
}

/**
 * A `before-input-event` listener that calls `onToggle` once per press.
 *
 * @param {{ platform?: string, onToggle: () => void }} options
 * @returns {(event: { preventDefault: () => void }, input: KeyInput) => void}
 */
function createHiddenFilesShortcutHandler({ platform = process.platform, onToggle }) {
  return (event, input) => {
    if (!matchesHiddenFilesShortcut(input, platform)) return;
    event.preventDefault();
    // Held down, the key repeats; the switch would flicker instead of flip.
    if (input.isAutoRepeat === true) return;
    onToggle();
  };
}

module.exports = {
  matchesHiddenFilesShortcut,
  createHiddenFilesShortcutHandler,
};
