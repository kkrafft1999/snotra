'use strict';

const { createMessage } = require('../contracts/message');

// Reichert fetch-Fehler um die undici-cause (ECONNREFUSED, ENOTFOUND, …) an,
// damit lokale Verbindungsprobleme (Ollama, MLX-LM) diagnostizierbar bleiben.
function fetchErrorCause(err) {
  const cause = err?.cause;
  return [cause?.code || cause?.errno, cause?.message].filter(Boolean).join(': ');
}

function describeFetchError(err, baseUrl) {
  const cause = fetchErrorCause(err);
  const main = err?.message || `Verbindung zu ${baseUrl} fehlgeschlagen.`;
  return cause ? `${main} (${cause})` : main;
}

/**
 * The same for the user's eyes (#308). What the network layer said is quoted as
 * it stands; only the sentence Snotra adds when it said nothing travels as a
 * key. Without `baseUrl` the sentence names the provider instead of an address.
 */
function describeFetchErrorMessage(err, baseUrl) {
  const cause = fetchErrorCause(err);
  const main = err?.message || (baseUrl
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
