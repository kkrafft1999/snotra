/**
 * Zeilenweises Matching für search_in_files — bewusst ohne Abhängigkeiten
 * und ohne Zugriff auf Modul-Konstanten, damit `collectLineMatches` per
 * `Function.prototype.toString()` unverändert in den Regex-Worker
 * (`regex-search-worker.js`) übertragen werden kann.
 */

/** Obergrenze für die Länge eines modellgelieferten regulären Ausdrucks. */
const SEARCH_MAX_PATTERN_CHARS = 256;
/** Zeilen werden nur bis zu dieser Länge gegen das Muster geprüft (Issue #69, ReDoS). */
const SEARCH_MAX_MATCH_LINE_CHARS = 10000;

/**
 * Sucht `matcher` in jeder Zeile von `text` und liefert Trefferzeilen mit Kontext.
 * `matcher` darf kein `g`/`y`-Flag tragen (test() wäre sonst zustandsbehaftet).
 *
 * options: { contextLines, maxMatches, matchLineChars, clipChars }
 *  - matchLineChars: Zeichen, die pro Zeile höchstens gegen das Muster geprüft werden.
 *  - clipChars: Zeichen, die pro Zeile höchstens zurückgegeben werden.
 */
function collectLineMatches(text, matcher, options) {
  const contextLines = options.contextLines;
  const maxMatches = options.maxMatches;
  const matchLineChars = options.matchLineChars;
  const clipChars = options.clipChars;
  const clip = (line) => (line.length <= clipChars ? line : `${line.slice(0, clipChars)}…`);
  const lines = text.split(/\r\n|\r|\n/);
  const matches = [];
  for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
    const line = lines[i];
    const probe = line.length > matchLineChars ? line.slice(0, matchLineChars) : line;
    if (!matcher.test(probe)) continue;
    matches.push({
      line: i + 1,
      text: clip(line),
      before: lines.slice(Math.max(0, i - contextLines), i).map(clip),
      after: lines.slice(i + 1, i + 1 + contextLines).map(clip),
    });
  }
  return matches;
}

/**
 * Heuristische Vorprüfung eines regulären Ausdrucks gegen katastrophales
 * Backtracking: abgelehnt werden Muster über der Längengrenze sowie
 * unbegrenzte Wiederholungen (`*`, `+`, `{n,}`) einer Gruppe, die selbst eine
 * unbegrenzte Wiederholung enthält — z. B. `(a+)+`, `(\w*\s?)*`, `((ab)*c)+`.
 * Das fängt die klassische ReDoS-Klasse ab; die harte Garantie liefert das
 * Zeitbudget des Workers.
 *
 * @returns {string|null} Fehlertext für das Modell oder null, wenn unauffällig.
 */
function validateRegexPattern(source, { maxChars = SEARCH_MAX_PATTERN_CHARS } = {}) {
  if (source.length > maxChars) {
    return `Regulärer Ausdruck zu lang (${source.length} Zeichen, erlaubt sind höchstens ${maxChars}).`;
  }
  const stack = [{ hasUnbounded: false }];
  let lastClosedGroup = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      lastClosedGroup = null;
      continue;
    }
    if (c === '[') {
      i += 1;
      if (source[i] === '^') i += 1;
      if (source[i] === ']') i += 1; // "[]" bzw. "[^]": schließende Klammer ist literal
      while (i < source.length && source[i] !== ']') {
        i += source[i] === '\\' ? 2 : 1;
      }
      i += 1;
      lastClosedGroup = null;
      continue;
    }
    if (c === '(') {
      stack.push({ hasUnbounded: false });
      i += 1;
      lastClosedGroup = null;
      continue;
    }
    if (c === ')') {
      const closed = stack.length > 1 ? stack.pop() : { hasUnbounded: false };
      if (closed.hasUnbounded) stack[stack.length - 1].hasUnbounded = true;
      lastClosedGroup = closed;
      i += 1;
      continue;
    }
    let unbounded = null;
    if (c === '*' || c === '+') {
      unbounded = true;
      i += 1;
    } else if (c === '?') {
      unbounded = false;
      i += 1;
    } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (m) {
        unbounded = m[2] !== undefined && m[3] === '';
        i += m[0].length;
      }
    }
    if (unbounded === null) {
      i += 1;
      lastClosedGroup = null;
      continue;
    }
    if (source[i] === '?') i += 1; // lazy-Variante (+?, *?, {n,}?)
    if (unbounded) {
      if (lastClosedGroup && lastClosedGroup.hasUnbounded) {
        return (
          'Regulärer Ausdruck zu komplex: verschachtelte unbegrenzte Wiederholungen wie "(a+)+" oder ' +
          '"(\\w*\\s?)*" können die Suche blockieren. Muster vereinfachen oder wörtlich suchen (is_regex=false).'
        );
      }
      stack[stack.length - 1].hasUnbounded = true;
    }
    lastClosedGroup = null;
  }
  return null;
}

module.exports = {
  SEARCH_MAX_PATTERN_CHARS,
  SEARCH_MAX_MATCH_LINE_CHARS,
  collectLineMatches,
  validateRegexPattern,
};
