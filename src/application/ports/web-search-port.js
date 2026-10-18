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

module.exports = {};
