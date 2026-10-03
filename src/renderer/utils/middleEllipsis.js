/**
 * Cuts a text in the middle so that it fits its box (#676). Folders of one
 * project family share their start (`snotra`, `snotra-promotion`,
 * `snotra-website`); an ellipsis at the end takes away exactly the part that
 * tells them apart, one in the middle keeps both ends.
 *
 * The box must clip (`overflow: hidden`, `white-space: nowrap`) so that its
 * width does not follow the text. Without a layout — a box not on screen, a
 * DOM without one — the text stays whole.
 */

const ELLIPSIS = '…';

/** `full` with `keep` characters left, split around an ellipsis. */
export function middleCut(full, keep) {
  if (keep >= full.length) return full;
  if (keep <= 0) return ELLIPSIS;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${full.slice(0, head)}${ELLIPSIS}${tail > 0 ? full.slice(full.length - tail) : ''}`;
}

/**
 * Whether the text runs past its box. Measured to the fraction of a pixel:
 * `scrollWidth` rounds, and a text half a pixel too wide would get the
 * stylesheet's ellipsis on top of the cut. Without a DOM range (a stand-in
 * in tests) the rounded widths have to do.
 */
function overflows(el) {
  const doc = el.ownerDocument;
  if (doc?.createRange && el.firstChild) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect().width;
    const box = el.getBoundingClientRect().width;
    if (text > 0 && box > 0) return text > box + 0.01;
  }
  return el.scrollWidth > el.clientWidth;
}

/**
 * Sets `full` into `el`, cut in the middle as far as needed. Returns whether
 * it was cut. Searches the longest cut that fits: a few layout reads, not one
 * per character.
 */
export function fitMiddle(el, full) {
  el.textContent = full;
  if (!el.clientWidth || !overflows(el)) return false;
  let low = 0;
  let high = full.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    el.textContent = middleCut(full, mid);
    if (overflows(el)) high = mid - 1;
    else low = mid;
  }
  el.textContent = middleCut(full, low);
  return true;
}
