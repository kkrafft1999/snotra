/**
 * Own-secrets port (#528): the app's own secrets, so that the chat core can
 * keep them out of the text it embeds in the prompt — skills, AGENTS.md and
 * the memory files (concept §5).
 *
 * Which secrets these are, and where they are stored, is known only to
 * `main/services/own-secrets.js`. The core only compares; it never shows,
 * logs or sends a value.
 */

/**
 * @typedef {Object} OwnSecretsPort
 * @property {() => Promise<string[]>} read  every own secret in every form it can
 *   turn up in; values under eight characters are ignored by the comparison
 */

module.exports = {};
