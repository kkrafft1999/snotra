import { APP_LOCALES } from '../i18n.js';

/**
 * The model name field of a provider that takes a free name (#1325): a text
 * field with a list of the loaded models next to it, after the ARIA combobox
 * pattern (list autocomplete, manual selection).
 *
 * It replaces a `<datalist>`. Chromium only offers the datalist entries that
 * match the text already in the field, so once a model name stood there every
 * other loaded model was out of reach. Here the toggle and ↓ always show the
 * whole list; only typing filters it.
 *
 * The field stays free text: nothing is picked unless the user picks it, so a
 * typed name survives Enter, Tab and a blur.
 */
export function initModelNameCombobox({ input, toggle, listbox }) {
  let models = []; // [{ id, label }] as loaded
  let shown = []; // what the open list holds
  let activeIndex = -1;
  // Set while a pick writes the field, so its input event does not filter.
  let picking = false;

  const isOpen = () => !listbox.classList.contains('hidden');

  function setExpanded(open) {
    const value = open ? 'true' : 'false';
    input.setAttribute('aria-expanded', value);
    toggle.setAttribute('aria-expanded', value);
  }

  function close() {
    activeIndex = -1;
    shown = [];
    input.removeAttribute('aria-activedescendant');
    setExpanded(false);
    if (!isOpen()) return;
    listbox.classList.add('hidden');
    listbox.innerHTML = '';
  }

  function markActive({ scroll = false } = {}) {
    const options = listbox.querySelectorAll('.model-combobox__option');
    options.forEach((el, i) => {
      el.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
    });
    const current = options[activeIndex];
    if (!current) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', current.id);
    if (scroll && typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest' });
    }
  }

  function buildOption(model, index, currentValue) {
    const li = document.createElement('li');
    li.className = 'model-combobox__option';
    li.id = `${listbox.id}-${index}`;
    li.setAttribute('role', 'option');
    li.setAttribute('lang', APP_LOCALES.EN);
    li.dataset.index = String(index);
    li.dataset.value = model.id;
    // The model in the field gets a check mark: in the full list it is the
    // one place that says where you are.
    if (model.id === currentValue) li.classList.add('model-combobox__option--current');

    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'model-combobox__check');
    check.setAttribute('viewBox', '0 0 16 16');
    check.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M3.5 8.5l3 3 6-7');
    check.appendChild(path);
    li.appendChild(check);

    const name = document.createElement('span');
    name.className = 'model-combobox__name';
    name.textContent = model.id;
    li.appendChild(name);

    if (model.label && model.label !== model.id) {
      const label = document.createElement('span');
      label.className = 'model-combobox__label';
      label.textContent = model.label;
      li.appendChild(label);
    }
    return li;
  }

  /**
   * Opens the list. Without `query` it holds every loaded model and starts on
   * the one in the field; with one it holds the matches and starts on none,
   * so Enter keeps what was typed.
   */
  function open({ query = null } = {}) {
    const currentValue = input.value.trim();
    const needle = (query || '').trim().toLowerCase();
    shown = needle
      ? models.filter((m) => m.id.toLowerCase().includes(needle)
        || (m.label || '').toLowerCase().includes(needle))
      : models.slice();
    if (shown.length === 0) {
      close();
      return;
    }
    listbox.innerHTML = '';
    shown.forEach((m, i) => listbox.appendChild(buildOption(m, i, currentValue)));
    listbox.classList.remove('hidden');
    setExpanded(true);

    activeIndex = needle ? -1 : shown.findIndex((m) => m.id === currentValue);
    markActive();
    // Start where the field stands, even when that is not the active option.
    const anchor = listbox.children[activeIndex]
      || listbox.querySelector('.model-combobox__option--current');
    if (anchor && typeof anchor.scrollIntoView === 'function') {
      anchor.scrollIntoView({ block: 'nearest' });
    }
  }

  function move(delta) {
    if (shown.length === 0) return;
    if (activeIndex < 0) activeIndex = delta > 0 ? 0 : shown.length - 1;
    else activeIndex = (activeIndex + delta + shown.length) % shown.length;
    markActive({ scroll: true });
  }

  function pick(index) {
    const model = shown[index];
    if (!model) return;
    close();
    if (input.value !== model.id) {
      input.value = model.id;
      picking = true;
      try {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } finally {
        picking = false;
      }
    }
    input.focus();
  }

  /**
   * The loaded models, deduplicated by the caller. An empty list hides the
   * toggle: there is nothing to open.
   * @param {{ id: string, label?: string }[]} list
   */
  function setModels(list) {
    models = Array.isArray(list) ? list.slice() : [];
    toggle.classList.toggle('hidden', models.length === 0);
    input.setAttribute('aria-autocomplete', models.length ? 'list' : 'none');
    close();
  }

  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const openNow = isOpen();
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (models.length === 0) return;
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        if (!openNow) {
          // ↓/↑ open on the model in the field, or else on the first/last
          // one; Alt+↓ only opens.
          open();
          if (!e.altKey && activeIndex < 0) move(delta);
          return;
        }
        if (e.altKey && delta < 0) {
          close();
          return;
        }
        move(delta);
        return;
      }
      case 'Enter':
        if (!openNow || activeIndex < 0) {
          if (openNow) close();
          return;
        }
        e.preventDefault();
        pick(activeIndex);
        return;
      case 'Escape':
        if (!openNow) return;
        // The list closes first; the dialog only on the next Escape.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        close();
        return;
      default:
    }
  });

  input.addEventListener('input', () => {
    if (picking) return;
    if (models.length === 0) return;
    const query = input.value.trim();
    if (!query) {
      // An emptied field shows everything again, as the datalist did.
      open();
      return;
    }
    open({ query });
  });

  input.addEventListener('blur', () => close());

  // The focus stays in the field; a blur would close the list before the
  // click lands.
  toggle.addEventListener('mousedown', (e) => e.preventDefault());
  toggle.addEventListener('click', () => {
    if (isOpen()) {
      close();
    } else {
      open();
    }
    input.focus();
  });

  listbox.addEventListener('mousedown', (e) => e.preventDefault());
  listbox.addEventListener('click', (e) => {
    const option = e.target.closest('.model-combobox__option');
    if (!option) return;
    pick(Number(option.dataset.index));
  });
  listbox.addEventListener('mouseover', (e) => {
    const option = e.target.closest('.model-combobox__option');
    if (!option) return;
    const index = Number(option.dataset.index);
    if (!Number.isInteger(index) || index === activeIndex) return;
    activeIndex = index;
    markActive();
  });

  setModels([]);

  return {
    setModels,
    close,
    isOpen,
    hasModels: () => models.length > 0,
  };
}
