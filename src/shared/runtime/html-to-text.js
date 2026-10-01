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

/*
 * The page is written by a stranger, and the reduction runs in the main
 * process, so it has to take time linear in the page (#550). Regular
 * expressions that look for a closing counterpart (`<!--[\s\S]*?-->`,
 * `<[^>]+>`) rescan to the end for every opening without one — 256 KB of
 * `<!--` blocked the app for twelve seconds. The scanner below finds every
 * delimiter with `indexOf` and never searches the same stretch twice.
 */

/** Raw text in a browser: an element that is never closed runs to the end. */
const DROPPED_RAW_ELEMENTS = new Set(['script', 'style', 'noscript', 'iframe']);
/** Ordinary elements whose content is not page text; unclosed, only the tag goes. */
const DROPPED_ELEMENTS = new Set(['template', 'svg', 'canvas', 'form', 'head']);
const BLOCK_ELEMENTS = new Set(['p', 'div', 'section', 'article', 'tr', 'ul', 'ol', 'dl', 'blockquote', 'pre', 'table']);
const TAG_NAME_CHAR = /[a-z0-9:-]/;
/** What opens markup after `<`, as in a browser; anything else is text ("a < b"). */
const MARKUP_START = /[a-zA-Z/!?]/;

/** Lower case for ASCII only, so that every index still matches the original. */
function asciiLower(text) {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function readTagName(lower, start) {
  let end = start;
  while (end < lower.length && TAG_NAME_CHAR.test(lower[end])) end += 1;
  return lower.slice(start, end);
}

/**
 * `indexOf` that remembers its answers: once a token was not found from one
 * position, it is not there from any later one either, and a hit further on
 * still holds for every start before it.
 */
function createFinder(text) {
  const found = new Map();
  return (token, from) => {
    const known = found.get(token);
    if (known === -1 || (known !== undefined && known >= from)) return known;
    const at = text.indexOf(token, from);
    found.set(token, at);
    return at;
  };
}

function markupFor(name, closing) {
  if (name === 'br') return '\n';
  const heading = /^h([1-6])$/.exec(name);
  if (heading) return closing ? '\n\n' : `\n\n${'#'.repeat(Number(heading[1]))} `;
  if (closing) {
    if (BLOCK_ELEMENTS.has(name)) return '\n\n';
    if (name === 'td' || name === 'th') return ' | ';
  } else if (name === 'li') {
    return '\n- ';
  }
  return ' ';
}

/** Titel aus dem <title>-Element, schon entschluesselt und gekuerzt. */
function extractTitle(html) {
  if (typeof html !== 'string' || !html) return '';
  const lower = asciiLower(html);
  let at = lower.indexOf('<title');
  while (at !== -1 && TAG_NAME_CHAR.test(lower[at + 6] || '')) at = lower.indexOf('<title', at + 6);
  if (at === -1) return '';
  const open = html.indexOf('>', at);
  const close = open === -1 ? -1 : lower.indexOf('</title>', open + 1);
  if (close === -1) return '';
  const title = decodeEntities(html.slice(open + 1, close)).replace(/\s+/g, ' ').trim();
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

/**
 * Markup out, structure kept: comments and the dropped elements disappear with
 * their content, headings, list items, paragraph and table ends become
 * Markdown-like breaks, every other tag a space.
 */
function stripMarkup(html) {
  const lower = asciiLower(html);
  const find = createFinder(lower);
  const parts = [];
  let textStart = 0;
  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf('<', at);
    if (lt === -1) break;
    if (!MARKUP_START.test(html[lt + 1] || '')) {
      at = lt + 1;
      continue;
    }
    parts.push(html.slice(textStart, lt));
    let end;
    let replacement = ' ';
    if (html.startsWith('<!--', lt)) {
      // An unclosed comment runs to the end, as in a browser.
      const close = html.indexOf('-->', lt + 4);
      end = close === -1 ? html.length : close + 3;
    } else {
      const closing = html[lt + 1] === '/';
      const name = html[lt + 1] === '!' || html[lt + 1] === '?' ? '' : readTagName(lower, lt + (closing ? 2 : 1));
      const gt = html.indexOf('>', lt + 1);
      if (gt === -1) {
        // A tag cut off at the end: nothing after it is text.
        end = html.length;
      } else {
        end = gt + 1;
        const selfClosing = html[gt - 1] === '/';
        const raw = DROPPED_RAW_ELEMENTS.has(name);
        if (!closing && !selfClosing && (raw || DROPPED_ELEMENTS.has(name))) {
          const close = find(`</${name}`, end);
          const closeEnd = close === -1 ? -1 : html.indexOf('>', close);
          if (closeEnd !== -1) end = closeEnd + 1;
          else if (raw) end = html.length;
        } else {
          replacement = markupFor(name, closing);
        }
      }
    }
    parts.push(replacement);
    at = end;
    textStart = end;
  }
  parts.push(html.slice(textStart));
  return parts.join('');
}

function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  let text = decodeEntities(stripMarkup(html));

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
