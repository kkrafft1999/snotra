/**
 * Erscheinungsbild der Oberflaeche (hell/dunkel). Umgeschaltet wird es unter
 * Einstellungen › Allgemein; bis v1.7.3 sass dafuer ein Knopf in der
 * Titelleiste.
 *
 * Die Wahl liegt bewusst im localStorage und nicht in den UI-Prefs des
 * Main-Prozesses: Sie muss schon beim ersten Aufbau der Seite feststehen.
 * Ueber IPC kaeme sie erst nach dem ersten Bild — das helle Theme wuerde bei
 * jedem Start kurz aufblitzen.
 */
const STORAGE_KEY = 'theme';

export function normalizeTheme(value) {
  return value === 'dark' ? 'dark' : 'light';
}

export function initTheme() {
  function setTheme(mode) {
    const theme = normalizeTheme(mode);
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem(STORAGE_KEY, theme);
    return theme;
  }

  function getTheme() {
    return normalizeTheme(localStorage.getItem(STORAGE_KEY));
  }

  setTheme(getTheme());

  return { setTheme, getTheme };
}
