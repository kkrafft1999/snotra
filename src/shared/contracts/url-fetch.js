'use strict';

/**
 * Constants of the URL fetch (#95): the error codes the handler tells apart, the
 * bounds of a fetch and the content types that pass as text. The shape of a
 * call is the port's business (`application/ports/url-fetch-port.js`, types
 * only); the values live here so that a port file stays a type declaration
 * (#1098).
 */

/** Fehlerarten, die der Handler unterscheiden koennen muss. */
const URL_FETCH_ERROR_CODES = Object.freeze({
  INVALID_URL: 'INVALID_URL',
  BLOCKED_ADDRESS: 'BLOCKED_ADDRESS',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  TOO_LARGE: 'TOO_LARGE',
  NETWORK: 'NETWORK',
  SERVICE: 'SERVICE',
});

/**
 * Obergrenzen des Abrufs — auch das Modell darf sie nicht ueberschreiten.
 *
 * MAX_BYTES entspricht der Grenze der Datei-Tools (2 MB). Die Zeichengrenze
 * liegt darunter: eine Webseite besteht zum grossen Teil aus Navigation und
 * Fusszeilen, und der Text landet ungefiltert im Kontext des Modells.
 */
const URL_FETCH_LIMITS = Object.freeze({
  DEFAULT_MAX_CHARS: 20_000,
  MAX_MAX_CHARS: 100_000,
  MAX_BYTES: 2 * 1024 * 1024,
  MAX_REDIRECTS: 3,
  TIMEOUT_MS: 15_000,
});

/** Inhaltstypen, die als Text durchgehen. Alles andere wird abgelehnt. */
const URL_FETCH_ALLOWED_CONTENT_TYPES = Object.freeze([
  'text/html',
  'text/plain',
  'text/markdown',
  'application/xhtml+xml',
  'application/json',
  'application/ld+json',
]);

module.exports = {
  URL_FETCH_ERROR_CODES,
  URL_FETCH_LIMITS,
  URL_FETCH_ALLOWED_CONTENT_TYPES,
};

module.exports = {
  URL_FETCH_ERROR_CODES,
  URL_FETCH_LIMITS,
  URL_FETCH_ALLOWED_CONTENT_TYPES,
};
