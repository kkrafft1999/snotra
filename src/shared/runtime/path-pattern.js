/**
 * Pfadmuster für Berechtigungsregeln und sensible Pfade (Issue #66,
 * Konzept §7): definierte `*`/`**`-Semantik statt Shell-Globs oder frei
 * ausführbarer Regex.
 *
 *  - `*`  passt auf beliebig viele Zeichen innerhalb eines Segments
 *  - `**` passt auf null oder mehr ganze Segmente
 *  - alle anderen Zeichen sind wörtlich
 *
 * Verglichen wird gegen posix-normalisierte relative Pfade (`a/b/c`). Ein
 * Muster ohne `/`, z. B. `*.pem`, gilt für den Dateinamen an jeder Stelle
 * (wie in .gitignore). Ein Muster mit `/` ist an der Wurzel verankert.
 * Ein Muster, das auf `/**` endet, trifft auch das Verzeichnis selbst.
 */
'use strict';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bringt einen Pfad in die Vergleichsform: `/`-Trenner, ohne `./`, ohne Rand-Slashes. */
function normalizePathForMatch(rawPath) {
  const text = typeof rawPath === 'string' ? rawPath.trim() : '';
  let normalized = text.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  normalized = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  return segments.join('/');
}

function segmentToRegExpSource(segment) {
  return segment
    .split('*')
    .map(escapeRegExp)
    .join('[^/]*');
}

/**
 * Kompiliert ein Muster in eine RegExp. `caseInsensitive` ist für
 * Sensitivitätsmuster gedacht (Konzept §4), Regelmuster vergleichen exakt.
 */
function compilePathPattern(rawPattern, { caseInsensitive = false } = {}) {
  const pattern = normalizePathForMatch(rawPattern);
  if (!pattern || pattern === '**') {
    return { regex: /^.*$/, anchored: false, matchesSelf: true };
  }
  const anchored = pattern.includes('/');
  const segments = pattern.split('/');
  const MIDDLE_ANY = '(?:[^/]+/)*';
  const TRAILING_ANY = '(?:/.*)?';
  let source = '';
  let previousWasMiddleAny = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      // Null oder mehr Segmente; am Ende auch „das Verzeichnis selbst“.
      if (isLast) {
        source += TRAILING_ANY;
      } else {
        if (source && !previousWasMiddleAny) source += '/';
        source += MIDDLE_ANY;
      }
      previousWasMiddleAny = !isLast;
      continue;
    }
    // Ein mittleres `**` endet bereits mit einem Trenner; sonst trennt `/`.
    if (source && !previousWasMiddleAny) source += '/';
    source += segmentToRegExpSource(segment);
    previousWasMiddleAny = false;
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  const regex = new RegExp(`${prefix}${source}$`, caseInsensitive ? 'i' : '');
  return { regex, anchored, matchesSelf: pattern.endsWith('/**') };
}

/** true, wenn der Pfad auf das Muster passt. */
function matchesPathPattern(rawPattern, rawPath, options) {
  const compiled = compilePathPattern(rawPattern, options);
  const candidate = normalizePathForMatch(rawPath);
  return compiled.regex.test(candidate);
}

module.exports = {
  normalizePathForMatch,
  compilePathPattern,
  matchesPathPattern,
};
