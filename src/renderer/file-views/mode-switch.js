// "Preview | Source" in the header of the file preview — for Markdown (#344)
// and for SVG (#345), which both have a rendered and a written form.
//
// Decided with a mockup on 2026-09-26: the compact `ds-segmented` control, and
// "Preview" stays English in German too.

import { t } from '../i18n.js';

export const MODES = Object.freeze({ PREVIEW: 'preview', SOURCE: 'source' });

// Radio groups need a name that is unique in the window; a counter is enough.
let switchCount = 0;

/**
 * Builds the control. `onChange(mode)` runs when the user picks the other
 * mode; `select(mode)` sets it from outside without calling back.
 */
export function buildModeSwitch(onChange) {
  switchCount += 1;
  const name = `file-view-mode-${switchCount}`;
  const group = document.createElement('div');
  group.className = 'ds-segmented ds-segmented--compact file-view-mode-switch';
  group.setAttribute('role', 'radiogroup');

  const options = {};
  for (const mode of [MODES.PREVIEW, MODES.SOURCE]) {
    const label = document.createElement('label');
    label.className = 'ds-segmented__option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.className = 'ds-segmented__input';
    input.name = name;
    input.value = mode;
    input.checked = mode === MODES.PREVIEW;
    input.addEventListener('change', () => {
      if (input.checked) onChange(mode);
    });
    const text = document.createElement('span');
    label.append(input, text);
    group.append(label);
    options[mode] = { input, text };
  }
  options[MODES.PREVIEW].text.lang = 'en';

  function applyLabels() {
    group.setAttribute('aria-label', t('fileView.mode.label'));
    options[MODES.PREVIEW].text.textContent = t('fileView.mode.preview');
    options[MODES.SOURCE].text.textContent = t('fileView.mode.source');
  }
  applyLabels();

  return {
    element: group,
    applyLabels,
    select(mode) {
      options[mode].input.checked = true;
    },
  };
}
