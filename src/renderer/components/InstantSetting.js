// Settings that take effect the moment they are changed (issue #297).
//
// A switch promises "this is on now", so the on/off settings and the two-way
// choices save on change instead of waiting for Apply. Each control has a
// small status next to it: a short "Saved" that fades, or "Not saved" that
// stays until the next attempt — and on failure the control goes back to the
// value that is actually stored.

import { t } from '../i18n.js';

const SAVED_VISIBLE_MS = 1600;

/**
 * The status next to a control. The element carries `role="status"`, so a
 * screen reader hears the outcome without the focus moving.
 */
export function createInstantStatus(el) {
  let timer = null;

  function show(key, isError) {
    if (!el) return;
    clearTimeout(timer);
    el.textContent = t(key);
    el.classList.toggle('is-error', isError);
    el.classList.add('is-visible');
    if (!isError) {
      timer = setTimeout(() => el.classList.remove('is-visible'), SAVED_VISIBLE_MS);
    }
  }

  return {
    saved: () => show('settings.instant.saved', false),
    failed: () => show('settings.instant.failed', true),
    clear() {
      if (!el) return;
      clearTimeout(timer);
      el.classList.remove('is-visible', 'is-error');
      el.textContent = '';
    },
  };
}

/**
 * The shared half of both controls: on every change it runs `save`, and the
 * control ends up showing what is stored — the new value on success, the
 * previous one on failure.
 *
 * `read` gives the value the control is showing, `write` puts one back. Only
 * the latest change decides: flipping twice quickly must not let the first,
 * slower answer undo the second.
 */
function bindInstant({ statusEl, targets, read, write, save }) {
  const status = createInstantStatus(statusEl);
  /** The value the store is known to hold — where a failed save returns to. */
  let confirmed = read();
  let latest = 0;

  async function run() {
    const mine = ++latest;
    const value = read();
    let ok;
    try {
      ok = (await save(value)) !== false;
    } catch {
      ok = false;
    }
    if (mine !== latest) return;
    if (ok) {
      confirmed = value;
      status.saved();
    } else {
      write(confirmed);
      status.failed();
    }
  }

  for (const target of targets) {
    target.addEventListener('change', () => {
      if (target.type === 'radio' && !target.checked) return;
      void run();
    });
  }

  return {
    status,
    get: read,
    /** Show a stored value without saving it — the dialog does this on open. */
    set(value) {
      confirmed = value;
      write(value);
    },
  };
}

/** A native `<input type="checkbox" role="switch">` that saves on change. */
export function bindInstantSwitch(input, statusEl, save) {
  if (!input) return { status: createInstantStatus(null), get: () => undefined, set() {} };
  return bindInstant({
    statusEl,
    targets: [input],
    read: () => input.checked,
    write: (value) => { input.checked = value; },
    save,
  });
}

/** A group of native radios shown as a segmented control. */
export function bindInstantChoice(group, statusEl, save) {
  const radios = group ? [...group.querySelectorAll('input[type="radio"]')] : [];
  return bindInstant({
    statusEl,
    targets: radios,
    read: () => radios.find((r) => r.checked)?.value ?? null,
    write: (value) => { for (const r of radios) r.checked = r.value === value; },
    save,
  });
}
