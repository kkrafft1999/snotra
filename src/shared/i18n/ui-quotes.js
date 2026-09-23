'use strict';

/**
 * Menu paths quoted in model-facing text (issue #294, part of #277).
 *
 * The model names a settings page so the user can find it — "the user can
 * enable it under …". The sentence around that goes to the model and stays
 * English (#276); only the quotation follows the interface language, because
 * an English interface has no page called "Einstellungen › Tools".
 *
 * A path is assembled from the **same catalogue entries as the navigation
 * itself**, never from a second list of its own. Rename a settings page and
 * the quotation moves with it; a list kept alongside would quietly drift.
 */

const { translate } = require('./index');

/** The separator of the settings navigation. The same glyph in both languages. */
const MENU_SEPARATOR = ' › ';

/**
 * Every path the model may quote, as the chain of catalogue keys that spells
 * it out. Adding one here is what makes `{menu:…}` resolve.
 */
const MENU_PATHS = Object.freeze({
  settings: ['settings.title'],
  'settings.tools': ['settings.title', 'settings.nav.tools'],
  'settings.permissions': ['settings.title', 'settings.nav.permissions'],
  'settings.skills': ['settings.title', 'settings.nav.skills'],
  'settings.skills.suggestions': ['settings.title', 'settings.nav.skills', 'settings.skills.suggestion.label'],
  'settings.memory': ['settings.title', 'settings.nav.memory'],
  'settings.mcp': ['settings.title', 'settings.nav.mcp'],
  'settings.general': ['settings.title', 'settings.nav.general'],
  'settings.models': ['settings.title', 'settings.nav.models'],
});

/** One path in one language, e.g. `Settings › Tools` / `Einstellungen › Tools`. */
function menuPath(locale, name) {
  const keys = MENU_PATHS[name];
  if (!keys) return name;
  return keys.map((key) => translate(locale, key)).join(MENU_SEPARATOR);
}

/**
 * Replaces every `{menu:…}` and `{label:…}` in a text. Used on the app's own
 * strings and on the system skills — never on a folder skill, which is someone
 * else's text, and never on a tool result, which is data.
 *
 * An unknown name is left standing rather than swallowed: a visible
 * `{menu:settings.tulls}` is found, an empty gap in a sentence is not.
 */
function fillUiQuotes(locale, text) {
  if (typeof text !== 'string') return text;
  if (!text.includes('{menu:') && !text.includes('{label:')) return text;
  return text
    .replace(/\{menu:([\w.]+)\}/g, (whole, name) => (MENU_PATHS[name] ? menuPath(locale, name) : whole))
    .replace(/\{label:([\w.]+)\}/g, (whole, key) => {
      const value = translate(locale, key);
      return value === key ? whole : value;
    });
}

module.exports = {
  MENU_PATHS,
  MENU_SEPARATOR,
  fillUiQuotes,
  menuPath,
};
