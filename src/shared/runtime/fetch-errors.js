'use strict';

const { createMessage, isMessage } = require('../contracts/message');
const { isRecord } = require('./is-record');

// Reichert fetch-Fehler um die undici-cause (ECONNREFUSED, ENOTFOUND, …) an,
// damit lokale Verbindungsprobleme (Ollama, MLX-LM) diagnostizierbar bleiben.
/** @param {unknown} err */
function fetchErrorCause(err) {
  const cause = isRecord(err) ? err.cause : undefined;
  if (!isRecord(cause)) return '';
  return [cause.code || cause.errno, cause.message].filter(Boolean).join(': ');
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  const message = isRecord(err) ? err.message : undefined;
  return typeof message === 'string' ? message : '';
}

/**
 * @param {unknown} err
 * @param {string} [baseUrl]
 */
function describeFetchError(err, baseUrl) {
  const cause = fetchErrorCause(err);
  const main = messageOf(err) || `Connection to ${baseUrl} failed.`;
  return cause ? `${main} (${cause})` : main;
}

/**
 * The same for the user's eyes (#308). What the network layer said is quoted as
 * it stands; only the sentence Snotra adds when it said nothing travels as a
 * key. Without `baseUrl` the sentence names the provider instead of an address.
 *
 * @param {unknown} err
 * @param {string} [baseUrl]
 * @returns {string | import('../contracts/message').Message}
 */
function describeFetchErrorMessage(err, baseUrl) {
  // A failure Snotra describes itself — a stream over its limit, say (#539)
  // — travels as a key in `userMessage`.
  const own = isRecord(err) ? err.userMessage : undefined;
  if (typeof own === 'string' && own) return own;
  if (isMessage(own)) return own;
  const cause = fetchErrorCause(err);
  const main = messageOf(err) || (baseUrl
    ? createMessage('provider.error.connectionFailed', { url: baseUrl })
    : createMessage('provider.error.connectionFailed.generic'));
  if (!cause) return main;
  if (typeof main === 'string') return `${main} (${cause})`;
  return createMessage('provider.error.withCause', { message: main, cause });
}

module.exports = {
  describeFetchError,
  describeFetchErrorMessage,
};
