'use strict';

/**
 * HTML auf lesbaren Text reduzieren (Issue #95).
 *
 * Das Modell soll den Inhalt einer Seite lesen, nicht ihr Markup: rohes HTML
 * kostet ein Vielfaches an Token und besteht groesstenteils aus Navigation,
 * Skripten und Styling. Herausgeschnitten wird alles, was nicht Fliesstext
 * ist; Ueberschriften, Listen und Absaetze bleiben als Markdown-nahe Struktur
 * erhalten, damit die Gliederung nicht verloren geht.
 *
 * Bewusst ein eigener, kleiner Reduzierer statt eines HTML-Parsers: die App
 * bringt keinen mit, und fuer diesen Zweck genuegt ein robustes Abraeumen.
 * Der Text ist Anzeige- und Modellfutter, nie Markup, das wieder gerendert
 * wird — die Chat-Anzeige bereinigt ihrerseits (DOMPurify).
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  bdquo: '„',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  szlig: 'ß',
};

/**
 * Latin-1-Buchstaben, wie sie auf deutschen, franzoesischen und spanischen
 * Seiten vorkommen. Der Rest kommt heute als UTF-8 und braucht keine Tabelle.
 * Die Grossbuchstaben-Namen (&Auml;) entstehen daraus automatisch.
 */
const LATIN1_LETTERS =
  'agrave à aacute á acirc â atilde ã auml ä aring å aelig æ ccedil ç '
  + 'egrave è eacute é ecirc ê euml ë igrave ì iacute í icirc î iuml ï '
  + 'ntilde ñ ograve ò oacute ó ocirc ô otilde õ ouml ö oslash ø '
  + 'ugrave ù uacute ú ucirc û uuml ü yacute ý';

{
  const parts = LATIN1_LETTERS.split(' ');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const name = parts[i];
    const char = parts[i + 1];
    NAMED_ENTITIES[name] = char;
    NAMED_ENTITIES[name[0].toUpperCase() + name.slice(1)] = char.toUpperCase();
  }
}

/** &amp;, &#228; und &#xE4; aufloesen; Unbekanntes bleibt stehen. */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/** Titel aus dem <title>-Element, schon entschluesselt und gekuerzt. */
function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return '';
  const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  let text = html;

  // Alles, was kein Inhalt ist: Skripte, Styles, Navigation im Kopf, SVG-Pfade.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|svg|canvas|iframe|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');

  // Struktur, die erhalten bleiben soll, in Markdown-Naehe uebersetzen.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|tr|ul|ol|dl|blockquote|pre|table)\s*>/gi, '\n\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<\/(td|th)\s*>/gi, ' | ');
  text = text.replace(/<h([1-6])\b[^>]*>/gi, (_match, level) => `\n\n${'#'.repeat(Number(level))} `);
  text = text.replace(/<\/h[1-6]\s*>/gi, '\n\n');

  // Restliches Markup faellt weg; der Text dazwischen bleibt.
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);

  // Weissraum aufraeumen: Zeilen einzeln trimmen, mehr als eine Leerzeile
  // zusammenfassen, damit aus Layout-Luft kein Token-Verbrauch wird.
  text = text.replace(/\r\n?/g, '\n');
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

module.exports = { htmlToText, extractTitle, decodeEntities };
