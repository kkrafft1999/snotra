'use strict';

/**
 * Slug of a heading, the way GitHub builds it for `#anchor` links.
 *
 * Shared since #947: the Markdown viewer and the help window give headings
 * their anchors with it, and the model's `read_manual_page` has to name the
 * same anchors the help window jumps to. One function, so they cannot drift.
 *
 * @param {unknown} text
 */
function headingSlug(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

module.exports = { headingSlug };
