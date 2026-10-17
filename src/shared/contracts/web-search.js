'use strict';

/**
 * Constants of the web search (#63): the error codes the handler tells apart and
 * the bounds of a search. The shape of a call is the port's business
 * (`application/ports/web-search-port.js`, types only); the values live here so
 * that a port file stays a type declaration (#1098).
 */

/** Fehlerarten, die der Handler unterscheiden koennen muss. */
const WEB_SEARCH_ERROR_CODES = Object.freeze({
  NO_API_KEY: 'NO_API_KEY',
  INVALID_QUERY: 'INVALID_QUERY',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NETWORK: 'NETWORK',
  SERVICE: 'SERVICE',
});

/** Obergrenzen der Suche — auch das Modell darf sie nicht ueberschreiten. */
const WEB_SEARCH_LIMITS = Object.freeze({
  DEFAULT_MAX_RESULTS: 5,
  MAX_MAX_RESULTS: 10,
  MAX_QUERY_CHARS: 400,
  MAX_SNIPPET_CHARS: 500,
});

module.exports = { WEB_SEARCH_ERROR_CODES, WEB_SEARCH_LIMITS };

module.exports = { WEB_SEARCH_ERROR_CODES, WEB_SEARCH_LIMITS };
