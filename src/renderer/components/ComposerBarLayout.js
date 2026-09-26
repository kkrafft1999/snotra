/**
 * The composer bar in a narrow chat (#400). Docked next to an open file, the
 * bar has no room for the mic, both pills, the token counter and send in one
 * row; the model and mode pill then take a row of their own above the others.
 *
 * The pill group is moved in the DOM rather than reordered with CSS `order`:
 * that way the tab order keeps following what is on screen — pills first,
 * then mic, token counter and send.
 */

/** Below this bar width the pills get their own row. */
export const STACK_BAR_BELOW = 400;

/**
 * Puts the pill group where a bar of `width` px has room for it.
 *
 * @param {{bar: Element, start: Element, pills: Element, anchor: Element}} parts
 *   the bar, its start group, the pill group and the element the pills follow
 *   in a single row (the voice status next to the mic)
 * @param {number} width  the bar's width in px
 * @returns {boolean} whether the pills now sit on a row of their own
 */
export function applyComposerBarLayout({ bar, start, pills, anchor }, width) {
  const stacked = width < STACK_BAR_BELOW;
  const inPlace = stacked
    ? bar.firstElementChild === pills
    : pills.parentElement === start && pills.previousElementSibling === anchor;
  if (stacked) bar.dataset.stacked = 'true';
  else delete bar.dataset.stacked;
  if (inPlace) return stacked;
  // Moving a node takes the focus with it; a pill that had it keeps it.
  const focused = pills.contains(document.activeElement) ? document.activeElement : null;
  if (stacked) bar.prepend(pills);
  else anchor.after(pills);
  focused?.focus();
  return stacked;
}

export function initComposerBarLayout() {
  const bar = document.querySelector('.chat-composer-bar');
  const start = bar?.querySelector('.chat-composer-bar-start');
  const pills = document.getElementById('chat-composer-pills');
  const anchor = document.getElementById('chat-voice-status');
  if (!bar || !start || !pills || !anchor || typeof ResizeObserver !== 'function') return;
  const parts = { bar, start, pills, anchor };
  new ResizeObserver(([entry]) => applyComposerBarLayout(parts, entry.contentRect.width)).observe(bar);
}
