'use strict';

/**
 * The part of a release body that is written for the user (#1072).
 *
 * GitHub's generated list names every pull request the way a developer titles
 * it — test runs, CI, documentation. What the user is told is the section the
 * release skill writes on top, once per language, between HTML comments that
 * GitHub does not render:
 *
 *   <!-- snotra:notes en --> … <!-- snotra:notes de --> … <!-- snotra:notes end -->
 *
 * `scripts/release-user-notes.js` writes exactly this. Shared since #1191: the
 * update dialog shows the section of the release on offer, and the model's
 * `list_release_notes` reads the sections of the releases before it, so both
 * have to cut them out the same way.
 */

const NOTES_MARKER = /<!--\s*snotra:notes\s+([a-z]+)\s*-->/gi;

/**
 * The section in `locale`, else the one in `fallbackLocale`; an empty string
 * for a body without the markers — any release before #1072 — which has
 * nothing written for the user.
 *
 * @param {unknown} notes  the release body as GitHub delivers it
 * @param {string} locale
 * @param {string} fallbackLocale  stands in for a language the release does not have
 */
function userReleaseNotes(notes, locale, fallbackLocale) {
  const text = String(notes || '').replace(/\r\n?/g, '\n');
  /** @type {Record<string, string>} */
  const sections = {};
  /** @type {string|null} */
  let current = null;
  let from = 0;
  for (const match of text.matchAll(NOTES_MARKER)) {
    if (current) sections[current] = text.slice(from, match.index).trim();
    const name = match[1].toLowerCase();
    if (name === 'end') break;
    current = name;
    from = match.index + match[0].length;
  }
  return sections[locale] || sections[fallbackLocale] || '';
}

module.exports = { userReleaseNotes };
