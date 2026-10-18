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

module.exports = {};
