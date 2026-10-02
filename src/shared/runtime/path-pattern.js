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
 *
 * Matching runs segment by segment without a regular expression, in time
 * bounded by the lengths of pattern and path (CR-B17-10).
 */
'use strict';

/** Bringt einen Pfad in die Vergleichsform: `/`-Trenner, ohne `./`, ohne Rand-Slashes. */
function normalizePathForMatch(rawPath) {
  const text = typeof rawPath === 'string' ? rawPath.trim() : '';
  let normalized = text.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  normalized = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  return segments.join('/');
}

/**
 * Whether one path segment matches one pattern segment, `*` standing for any
 * run of characters (#650 follow-up, CR-B17-10).
 *
 * The patterns used to be compiled to regular expressions, `*` to `[^/]*`.
 * Several stars in one segment backtrack polynomially — ten `*a` against a
 * 40-character name took 19 s, on the main process and for every path a
 * listing classifies. This is the iterative last-star match instead: at most
 * segment length × pattern length steps, whatever the pattern.
 */
function matchSegment(pattern, text) {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      starP = p;
      starT = t;
      p += 1;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (starP !== -1) {
      p = starP + 1;
      starT += 1;
      t = starT;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * Whether the path segments match the pattern segments, `**` standing for
 * zero or more whole segments. Dynamic programming over the two segment
 * lists, so a pattern with many `**` stays linear in each.
 */
function matchSegments(patternSegments, pathSegments) {
  const rows = patternSegments.length;
  const cols = pathSegments.length;
  // reach[j]: the first i pattern segments can consume the first j path segments.
  let reach = new Array(cols + 1).fill(false);
  reach[0] = true;
  for (let i = 0; i < rows; i += 1) {
    const segment = patternSegments[i];
    const next = new Array(cols + 1).fill(false);
    if (segment === '**') {
      let any = false;
      for (let j = 0; j <= cols; j += 1) {
        any = any || reach[j];
        next[j] = any;
      }
    } else {
      for (let j = 1; j <= cols; j += 1) {
        next[j] = reach[j - 1] && matchSegment(segment, pathSegments[j - 1]);
      }
    }
    reach = next;
  }
  return reach[cols];
}

/**
 * Compiles a pattern into a matcher. `caseInsensitive` is meant for the
 * sensitivity patterns (concept §4); rule patterns compare exactly.
 *
 * @returns {{ test: (normalizedPath: string) => boolean, anchored: boolean, matchesSelf: boolean }}
 *   `test` takes a path already in the form `normalizePathForMatch` gives.
 */
function compilePathPattern(rawPattern, { caseInsensitive = false } = {}) {
  const fold = (text) => (caseInsensitive ? text.toLowerCase() : text);
  const pattern = normalizePathForMatch(rawPattern);
  if (!pattern || pattern === '**') {
    return { test: () => true, anchored: false, matchesSelf: true };
  }
  const anchored = pattern.includes('/');
  const segments = fold(pattern).split('/');
  const test = (normalizedPath) => {
    // An empty path is one empty segment, as it was for the regular expression.
    const pathSegments = fold(typeof normalizedPath === 'string' ? normalizedPath : '').split('/');
    // A pattern without `/` names a file or folder anywhere (like .gitignore):
    // it has a single segment, and the path's last one has to match it.
    if (!anchored) return matchSegment(segments[0], pathSegments[pathSegments.length - 1]);
    return matchSegments(segments, pathSegments);
  };
  return { test, anchored, matchesSelf: pattern.endsWith('/**') };
}

/** true, wenn der Pfad auf das Muster passt. */
function matchesPathPattern(rawPattern, rawPath, options) {
  const compiled = compilePathPattern(rawPattern, options);
  return compiled.test(normalizePathForMatch(rawPath));
}

module.exports = {
  normalizePathForMatch,
  compilePathPattern,
  matchesPathPattern,
};
