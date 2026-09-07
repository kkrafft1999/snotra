/**
 * Web-Such-Port: Suche im Internet, ohne dass der Core den Dienst kennt
 * (Issue #63).
 *
 * Der konkrete Anbieter (aktuell Tavily) sitzt im Adapter. Der Port ist
 * bewusst schmal gehalten: eine Anfrage rein, eine kompakte Trefferliste
 * raus. Fehler kommen als Ergebnis zurueck, nicht als Ausnahme — ein
 * fehlender Key oder ein Rate-Limit ist fuer das Modell eine Auskunft, kein
 * Absturz.
 */

/**
 * @typedef {Object} WebSearchResult
 * @property {string} title
 * @property {string} url
 * @property {string} snippet   kurzer Auszug, kein Volltext
 * @property {string} [publishedAt]  ISO-Datum, falls der Dienst eines liefert
 */

/**
 * @typedef {Object} WebSearchOk
 * @property {true} ok
 * @property {string} query      die tatsaechlich gestellte Anfrage
 * @property {WebSearchResult[]} results
 * @property {string} [answer]   Kurzantwort des Dienstes, falls vorhanden
 */

/**
 * @typedef {Object} WebSearchError
 * @property {false} ok
 * @property {string} error   Klartext fuer das Modell und die Anzeige
 * @property {string} code    WEB_SEARCH_ERROR_CODES-Wert
 */

/**
 * @typedef {Object} WebSearchPort
 * @property {() => boolean} isConfigured
 *   Ob ein Schluessel hinterlegt ist. Synchron, weil die Tool-Sichtbarkeit
 *   beim Bauen der Tool-Liste feststehen muss.
 * @property {(request: { query: string, maxResults?: number, language?: string, abortSignal?: AbortSignal })
 *   => Promise<WebSearchOk|WebSearchError>} search
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
