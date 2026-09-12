/**
 * URL-Abruf-Port (Issue #95): eine Adresse rein, lesbarer Text raus.
 *
 * `web_search` liefert je Treffer nur einen kurzen Auszug. Wer ein Changelog,
 * eine Norm oder eine Fehlermeldung am Stueck lesen will, braucht die Seite
 * selbst. Der Port ist bewusst schmal: genau eine http(s)-Adresse, ein
 * gekuerzter Text als Ergebnis, kein rohes HTML und kein Download.
 *
 * Fehler kommen als Ergebnis zurueck, nicht als Ausnahme — eine gesperrte
 * Adresse oder ein 404 ist fuer das Modell eine Auskunft, kein Absturz.
 */

/**
 * @typedef {Object} UrlFetchOk
 * @property {true} ok
 * @property {string} url        die tatsaechlich gelesene Adresse (nach Weiterleitungen)
 * @property {string} [title]    Seitentitel, falls vorhanden
 * @property {string} text       lesbarer Text als Markdown-naher Fliesstext
 * @property {boolean} truncated ob `text` an der Zeichengrenze gekuerzt wurde
 */

/**
 * @typedef {Object} UrlFetchError
 * @property {false} ok
 * @property {string} error   Klartext fuer das Modell und die Anzeige
 * @property {string} code    URL_FETCH_ERROR_CODES-Wert
 */

/**
 * @typedef {Object} UrlFetchPort
 * @property {(request: { url: string, maxCharacters?: number, abortSignal?: AbortSignal })
 *   => Promise<UrlFetchOk|UrlFetchError>} fetchUrl
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
