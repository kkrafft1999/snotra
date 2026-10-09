// The zoom of the Markdown preview (#829): one size for every Markdown file,
// remembered in the UI prefs. `app.js` restores it at start-up, before a file
// can be on show; the view reads it when it mounts and writes it when the
// user zooms, so the next file opens at the same size.

import contracts from '../generated/contracts.js';
import { ZOOM_STEPS } from './zoom-tools.js';

const { clampMarkdownZoom, MARKDOWN_ZOOM_MIN, MARKDOWN_ZOOM_MAX } = contracts;

/** The steps of the PDF and image zoom, within the range the prefs accept. */
export const MARKDOWN_ZOOM_STEPS = Object.freeze(
  ZOOM_STEPS.filter((step) => step >= MARKDOWN_ZOOM_MIN - 0.001 && step <= MARKDOWN_ZOOM_MAX + 0.001),
);

let zoom = 1;

export function markdownZoom() {
  return zoom;
}

/** Takes over the stored value; anything unusable means 100 %. */
export function restoreMarkdownZoom(value) {
  zoom = clampMarkdownZoom(value) ?? 1;
}

/** Sets the zoom and stores it. Returns the value that now applies. */
export function rememberMarkdownZoom(value, api) {
  const next = clampMarkdownZoom(value);
  if (next === undefined || next === zoom) return zoom;
  zoom = next;
  if (typeof api?.setUIPrefs === 'function') {
    void Promise.resolve(api.setUIPrefs({ markdownZoom: zoom })).catch(() => {});
  }
  return zoom;
}
