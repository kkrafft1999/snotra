/**
 * Help links in the settings (#848).
 *
 * A `?` next to a section heading opens the in-app manual at the page and
 * section about that setting; its label names the target ("Help: Give a folder
 * a default mode"). The button in the dialog's header follows the open
 * section and leads to its page, which is how the sections without a heading
 * of their own (Memory, General) get one too.
 *
 * The buttons sit in the markup with `data-manual-help`; the key names an entry
 * of SETTINGS_HELP in `../manual/settings-help-links.js`.
 */

import { t, getLocale, onLocaleChange } from '../i18n.js';
import { settingsHelpTarget } from '../manual/settings-help-links.js';

/**
 * Labels the `?` buttons under `root` and opens the manual on a click.
 * `refresh()` relabels them, for the header button after the section changed.
 */
export function initSettingsHelp({ root = document, api }) {
  const buttons = () => root.querySelectorAll('[data-manual-help]');

  function label(button) {
    const target = settingsHelpTarget(button.dataset.manualHelp, getLocale());
    if (!target) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    const text = t('settings.help.label', { target: target.label });
    button.setAttribute('aria-label', text);
    button.title = text;
  }

  function refresh() {
    for (const button of buttons()) label(button);
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-manual-help]');
    if (!button) return;
    const target = settingsHelpTarget(button.dataset.manualHelp, getLocale());
    if (!target) return;
    void Promise.resolve(api?.openManual?.({ slug: target.slug, fragment: target.fragment })).catch(() => {});
  });

  refresh();
  onLocaleChange(refresh);
  return { refresh };
}
