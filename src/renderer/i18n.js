/**
 * Language switching in the renderer (epic #277).
 *
 * One place holds the active locale, translates and redraws. Static markup
 * carries `data-i18n`, nodes built at runtime call `t()` — and anything that
 * keeps state of its own subscribes with `onLocaleChange()` and rebuilds
 * itself. A restart is explicitly not required.
 *
 * `data-i18n-html` assigns `innerHTML` and is therefore reserved for the
 * catalogues: those values live in the app's own source, never in an input.
 * Anything coming from a file, a model answer or a text field goes through
 * `data-i18n` or `textContent`.
 */

import i18n from './generated/i18n.js';

const { APP_LOCALES, DEFAULT_LOCALE, createTranslator, normalizeLocale } = i18n;

let currentLocale = DEFAULT_LOCALE;
let translator = createTranslator(currentLocale);
const listeners = new Set();

/** One string in the active language. */
export function t(key, params) {
  return translator(key, params);
}

/** One string in the active language, singular or plural by `count`. */
export function tPlural(baseKey, count, params) {
  return translator.plural(baseKey, count, params);
}

/** The active language — `de` or `en`. */
export function getLocale() {
  return currentLocale;
}

/**
 * Applies text, markup and translated attributes below `root`. `root` itself is
 * included: components often hand in exactly the node they have just built.
 */
export function applyTranslations(root = document) {
  const scope = root || document;
  const each = (selector, fn) => {
    if (typeof scope.matches === 'function' && scope.matches(selector)) fn(scope);
    scope.querySelectorAll?.(selector).forEach(fn);
  };

  each('[data-i18n]', (el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  each('[data-i18n-html]', (el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  // `title:key;aria-label:key` — one attribute per pair, several separated by `;`.
  each('[data-i18n-attr]', (el) => {
    for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
      const sep = pair.indexOf(':');
      if (sep <= 0) continue;
      const attr = pair.slice(0, sep).trim();
      const key = pair.slice(sep + 1).trim();
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
}

/**
 * Switches the language and redraws the interface. The same language means no
 * work: this call also sits in the startup path and should cost nothing there.
 */
export function setLocale(raw, { force = false } = {}) {
  const next = normalizeLocale(raw);
  if (next === currentLocale && !force) return currentLocale;
  currentLocale = next;
  translator = createTranslator(next);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
    applyTranslations(document);
  }
  for (const fn of listeners) {
    // A subscriber that throws must not take the others down with it — half the
    // interface would be left standing in the old language.
    try { fn(next); } catch { /* ignored */ }
  }
  return currentLocale;
}

/**
 * Registers a rebuild that goes beyond `data-i18n` — lists, menus, anything
 * with state of its own. Returns the unsubscribe function.
 */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export { APP_LOCALES };
