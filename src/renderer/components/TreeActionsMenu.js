import { dismissOnOutsideClick, dismissOnFocusLeave } from '../utils/helpers.js';

/**
 * The `⋯` menu in the tree header (#676). It holds what took four buttons
 * there until then — filter (#350), new file and new folder (#349), hidden
 * files (#436) — so the folder's name has room.
 *
 * The keyboard model is the folder history's and the model menu's (#583,
 * #638): the focus goes into the menu when it opens, the arrows move it,
 * Escape hands it back to the button, Tab past it closes it. A choice closes
 * the menu and gives the focus back to the button before the action runs, so
 * an action that takes the focus somewhere — the filter's field, the name
 * field of a new file — keeps it.
 *
 * `actions` maps each `data-action` of the markup to what it does.
 * `shortcuts` maps a `data-shortcut` to a function giving the key to show.
 */
export function initTreeActionsMenu({ actions = {}, shortcuts = {} } = {}) {
  const button = document.getElementById('btn-tree-actions');
  const menu = document.getElementById('tree-actions-menu');
  const wrapper = document.getElementById('tree-actions-wrapper');
  const inactive = { setAvailable() {}, setHiddenFilesChecked() {}, renderShortcuts() {}, close() {}, isOpen: () => false };
  if (!button || !menu) return inactive;

  const items = () => [...menu.querySelectorAll('[role^="menuitem"]')];
  const isOpen = () => !menu.classList.contains('hidden');

  function setCurrent(item) {
    for (const el of items()) el.tabIndex = el === item ? 0 : -1;
  }

  function open() {
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    button.setAttribute('aria-expanded', 'true');
    const first = items()[0];
    setCurrent(first);
    first?.focus();
  }

  /** `focusButton`: after Escape or a choice, where the focus would drop. */
  function close({ focusButton = false } = {}) {
    if (!isOpen()) return;
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  }

  function choose(item) {
    const run = actions[item?.dataset.action];
    close({ focusButton: true });
    run?.();
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[role^="menuitem"]');
    if (item) choose(item);
  });

  menu.addEventListener('focusin', (e) => {
    const item = e.target.closest('[role^="menuitem"]');
    if (item) setCurrent(item);
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close({ focusButton: true });
      return;
    }
    const list = items();
    const index = list.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = list[(index + 1) % list.length];
    else if (e.key === 'ArrowUp') next = list[index <= 0 ? list.length - 1 : index - 1];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    if (!next) return;
    e.preventDefault();
    next.focus();
  });

  dismissOnOutsideClick({
    isOpen,
    ownsTarget: (target) => menu.contains(target) || button.contains(target),
    onDismiss: () => close(),
  });
  dismissOnFocusLeave({ container: wrapper, isOpen, onDismiss: () => close() });

  function renderShortcuts() {
    for (const el of menu.querySelectorAll('[data-shortcut]')) {
      el.textContent = shortcuts[el.dataset.shortcut]?.() ?? '';
    }
  }
  renderShortcuts();

  return {
    /** The menu only stands while a folder is open. */
    setAvailable(available) {
      button.hidden = !available;
      if (!available) close();
    },
    /** The check in front of "Show hidden files". */
    setHiddenFilesChecked(on) {
      menu.querySelector('[data-action="hidden-files"]')?.setAttribute('aria-checked', on ? 'true' : 'false');
    },
    renderShortcuts,
    close,
    isOpen,
  };
}
