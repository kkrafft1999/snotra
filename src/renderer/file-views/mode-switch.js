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
  const control = buildSegmentedSwitch({
    labelKey: 'fileView.mode.label',
    options: [
      { value: MODES.PREVIEW, labelKey: 'fileView.mode.preview', lang: 'en' },
      { value: MODES.SOURCE, labelKey: 'fileView.mode.source' },
    ],
    selected: MODES.PREVIEW,
    onChange,
  });
  return control;
}

/**
 * The same compact `ds-segmented` control for any set of options — also
 * "Content | Changes" for a file the agent changed (#348). Each option is
 * `{ value, labelKey, lang? }`; `lang` marks a label that stays in one
 * language.
 */
export function buildSegmentedSwitch({ labelKey, options: choices, selected, onChange }) {
  switchCount += 1;
  const name = `file-view-mode-${switchCount}`;
  const group = document.createElement('div');
  group.className = 'ds-segmented ds-segmented--compact file-view-mode-switch';
  group.setAttribute('role', 'radiogroup');

  const options = {};
  for (const choice of choices) {
    const label = document.createElement('label');
    label.className = 'ds-segmented__option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.className = 'ds-segmented__input';
    input.name = name;
    input.value = choice.value;
    input.checked = choice.value === selected;
    input.addEventListener('change', () => {
      if (input.checked) onChange(choice.value);
    });
    const text = document.createElement('span');
    if (choice.lang) text.lang = choice.lang;
    label.append(input, text);
    group.append(label);
    options[choice.value] = { input, text, labelKey: choice.labelKey };
  }

  function applyLabels() {
    group.setAttribute('aria-label', t(labelKey));
    for (const option of Object.values(options)) option.text.textContent = t(option.labelKey);
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
