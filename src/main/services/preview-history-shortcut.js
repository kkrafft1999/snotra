'use strict';

/**
 * Back and forward through the files the preview showed (#822): Cmd+[ and
 * Cmd+] on macOS, as in Finder, Safari and Xcode; Alt+Left and Alt+Right on
 * Windows and Linux, as in every browser there.
 *
 * Matched on `before-input-event` by the physical key, like the hidden-files
 * shortcut (#436): `[` is Option+5 on a German Mac keyboard, so a menu
 * accelerator comparing characters would never fire there. The key in the
 * place of `[` on a US keyboard does — the convention the Mac's own apps keep
 * on other layouts. The View menu only shows the accelerators.
 */

const KEYS = {
  darwin: { BracketLeft: 'back', BracketRight: 'forward' },
  other: { ArrowLeft: 'back', ArrowRight: 'forward' },
};

/** 'back', 'forward' or null. */
function matchPreviewHistoryShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.shift === true) return null;
  if (platform === 'darwin') {
    if (input.meta !== true || input.control === true || input.alt === true) return null;
    return KEYS.darwin[input.code] ?? null;
  }
  if (input.alt !== true || input.control === true || input.meta === true) return null;
  return KEYS.other[input.code] ?? null;
}

/** A `before-input-event` listener that calls `onStep('back' | 'forward')`. */
function createPreviewHistoryShortcutHandler({ platform = process.platform, onStep }) {
  return (event, input) => {
    const direction = matchPreviewHistoryShortcut(input, platform);
    if (!direction) return;
    event.preventDefault();
    // A key held down would race through the list faster than it can draw.
    if (input.isAutoRepeat === true) return;
    onStep(direction);
  };
}

module.exports = {
  matchPreviewHistoryShortcut,
  createPreviewHistoryShortcutHandler,
};
