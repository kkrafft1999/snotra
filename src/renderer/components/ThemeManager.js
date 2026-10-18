/**
 * Erscheinungsbild der Oberflaeche (hell/dunkel). Umgeschaltet wird es unter
 * Einstellungen › Allgemein; bis v1.7.3 sass dafuer ein Knopf in der
 * Titelleiste.
 *
 * Die Wahl liegt bewusst im localStorage und nicht in den UI-Prefs des
 * Main-Prozesses: Sie muss schon beim ersten Aufbau der Seite feststehen.
 * Ueber IPC kaeme sie erst nach dem ersten Bild — das helle Theme wuerde bei
 * jedem Start kurz aufblitzen.
 *
 * Since #999 the choice can also be "system": the theme then follows the
 * operating system's setting through `prefers-color-scheme`, and changes with
 * it while the window is open. What is stored is the choice; what the page
 * shows (`data-theme`) is always light or dark.
 */
const STORAGE_KEY = 'theme';

export const APPEARANCES = Object.freeze(['light', 'dark', 'system']);

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** A stored or picked value as one of APPEARANCES; anything else is light, the default since v1.0. */
export function normalizeAppearance(value) {
  return APPEARANCES.includes(value) ? value : 'light';
}

/** The theme a choice shows: "system" turns into what the OS asks for. */
export function resolveTheme(appearance, systemPrefersDark) {
  const choice = normalizeAppearance(appearance);
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

/**
 * Applies the stored choice and keeps the page in step with it. `onChange`
 * hears every later change of the theme shown — a new choice, here or in
 * another window of the app, or the OS switching while "system" is chosen.
 */
export function initTheme({ onChange = null } = {}) {
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
  let appearance = 'light';
  let shown = null;

  function apply() {
    const theme = resolveTheme(appearance, media?.matches === true);
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    const changed = shown !== null && shown !== theme;
    shown = theme;
    if (changed) onChange?.(theme);
  }

  /** Picks an appearance, stores it and returns it as stored. */
  function setTheme(mode) {
    appearance = normalizeAppearance(mode);
    apply();
    localStorage.setItem(STORAGE_KEY, appearance);
    return appearance;
  }

  /** The choice: light, dark or system. */
  function getTheme() {
    return appearance;
  }

  /** The theme on screen: light or dark. */
  function getEffectiveTheme() {
    return shown;
  }

  media?.addEventListener?.('change', () => {
    if (appearance === 'system') apply();
  });

  setTheme(localStorage.getItem(STORAGE_KEY));

  return { setTheme, getTheme, getEffectiveTheme };
}
