// The zoom steps and the small icon buttons of the header tools, shared by
// the PDF preview (#346), the image preview (#345, #803) and the Markdown
// preview (#829), so that all of them zoom the same way and their buttons
// look alike.

export const ZOOM_STEPS = Object.freeze([0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]);

/**
 * The next zoom step in a direction, from wherever the zoom stands now.
 * `steps` for a view that only uses part of the range.
 */
export function nextZoom(current, direction, steps = ZOOM_STEPS) {
  if (direction > 0) return steps.find((step) => step > current + 0.001) ?? steps.at(-1);
  return [...steps].reverse().find((step) => step < current - 0.001) ?? steps[0];
}

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

/** A header tool button that shows a 16 × 16 stroke icon. */
export function iconButton(className, path) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `pdf-tools__button ${className}`;
  button.append(icon(path));
  return button;
}

export const ZOOM_OUT_ICON = 'M3.5 8h9';
export const ZOOM_IN_ICON = 'M3.5 8h9M8 3.5v9';
