'use strict';

/**
 * A message that has not been put into words yet (issue #293, part of #277).
 *
 * The contracts are the one layer that belongs to main *and* renderer, and the
 * two do not agree on a language: a validation error arises where the file is
 * written and is read where the interface lives. A finished sentence would
 * have to pick its language at the wrong end of that hop — and would then be
 * wrong the moment the user switches languages while the error is still on
 * screen.
 *
 * So a contract answers with the *key* and the values that fill it, and the
 * side that shows it looks the sentence up. `src/shared/i18n` translates the
 * descriptor (`translateMessage`, `t.message`); the shape lives here so that a
 * contract never has to reach for the catalogue — which would make the two
 * modules require each other in a circle.
 */

/**
 * One message, ready to travel.
 *
 * @param {string} key      Dotted catalogue key, e.g. `mcp.error.idMissing`.
 * @param {object} [params] Values for the `{placeholders}` in that entry.
 * @returns {{ key: string, params?: object }}
 */
function createMessage(key, params) {
  const out = { key: typeof key === 'string' ? key : '' };
  // An empty `params` would survive every structured clone and every JSON
  // round trip for nothing — the common message has no placeholders at all.
  if (params && typeof params === 'object' && Object.keys(params).length > 0) {
    out.params = { ...params };
  }
  return out;
}

/**
 * Is this a descriptor rather than a finished sentence? The distinction
 * matters on the display side: layers that have not been converted yet still
 * hand over plain text, and that text is shown as it stands.
 */
function isMessage(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.key === 'string' && value.key !== '';
}

module.exports = {
  createMessage,
  isMessage,
};
