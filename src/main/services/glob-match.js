'use strict';

/**
 * Glob and `.gitignore` matching without regular expressions (#644).
 *
 * The patterns used to be compiled into regexes — `*` as `[^/]*`, `**` as
 * `.*`, and an unanchored pattern behind "any prefix ending in a slash". A
 * pattern with several stars then backtracks polynomially, and the patterns
 * come from places nobody vets: every line of a cloned repository's
 * `.gitignore`, and the `find_files` / `search_in_files` arguments the model
 * picks. Seventeen characters of `.gitignore` froze the main process for more
 * than a minute.
 *
 * So the matching is done by hand, the way git's wildmatch defines it:
 *
 * - `*` matches any run of characters except `/`, `?` exactly one;
 * - `**` as a whole segment — at the start, between two slashes or at the
 *   end — matches across folders: zero or more of them, except at the end,
 *   where `x/**` matches everything *inside* `x` but not `x` itself; any
 *   other run of stars is a plain `*`;
 * - `[…]` is a bracket expression with ranges (`a-z`), `!` or `^` for
 *   negation and the POSIX classes (`[:digit:]`, …); it never matches `/`;
 * - a backslash makes the next character literal (`\#`, `\!`, `\*`, `\[`).
 *
 * A path is matched segment by segment, and each segment by the iterative
 * single-backtrack algorithm: a mismatch only ever moves the most recent
 * star, never an earlier one. That bounds a match by the product of pattern
 * and name length — no exponential case, whatever the pattern.
 *
 * Where git and this module part ways, deliberately: a `[` that does not open
 * a complete bracket expression is a literal `[` (git matches nothing), and
 * trailing tabs of a `.gitignore` line are dropped like trailing spaces.
 */

const STAR = 1;
const ANY = 2;
const LITERAL = 3;
const CLASS = 4;
/** Marks a whole-segment `**` in the list of segments. */
const GLOBSTAR = Symbol('globstar');

/**
 * Work one `.gitignore` may cost in one listing, in matching steps. A single
 * match is bounded, but a crafted file multiplies it: 2,000 long rules against
 * 5,000 long names take about eight minutes. A large ordinary `.gitignore`
 * (1,000 rules) over 5,000 paths takes some 30 million steps. Past this
 * budget — one to two seconds of work — the file stops being applied for the
 * rest of the listing instead of stalling the app.
 */
const GITIGNORE_MAX_STEPS = 500_000_000;

/** Loop steps of all matching so far; read as a difference, never reset. */
let steps = 0;

/** POSIX character classes in the C locale, as git's wildmatch knows them. */
const POSIX_CLASSES = {
  alnum: (c) => /[A-Za-z0-9]/.test(c),
  alpha: (c) => /[A-Za-z]/.test(c),
  blank: (c) => c === ' ' || c === '\t',
  cntrl: (c) => /[\x00-\x1f\x7f]/.test(c),
  digit: (c) => /[0-9]/.test(c),
  graph: (c) => /[\x21-\x7e]/.test(c),
  lower: (c) => /[a-z]/.test(c),
  print: (c) => /[\x20-\x7e]/.test(c),
  punct: (c) => /[!-/:-@[-`{-~]/.test(c),
  space: (c) => /[ \t\n\v\f\r]/.test(c),
  upper: (c) => /[A-Z]/.test(c),
  xdigit: (c) => /[0-9A-Fa-f]/.test(c),
};

/**
 * Reads a bracket expression starting at `chars[start] === '['`. Returns the
 * token and the index behind the closing `]`, or null when the expression is
 * not complete — the caller then takes the `[` literally.
 */
function parseBracket(chars, start) {
  let i = start + 1;
  let negated = false;
  if (chars[i] === '!' || chars[i] === '^') {
    negated = true;
    i += 1;
  }
  const items = [];
  let first = true;
  while (i < chars.length) {
    let c = chars[i];
    // A `]` right after `[` or `[!` is a member, not the end (as in git).
    if (c === ']' && !first) {
      return { token: { type: CLASS, negated, items }, next: i + 1 };
    }
    first = false;
    if (c === '[' && chars[i + 1] === ':') {
      let close = i + 2;
      while (close + 1 < chars.length && !(chars[close] === ':' && chars[close + 1] === ']')) close += 1;
      if (close + 1 < chars.length) {
        const test = POSIX_CLASSES[chars.slice(i + 2, close).join('')];
        if (!test) return null;
        items.push({ test });
        i = close + 2;
        continue;
      }
    }
    if (c === '\\' && i + 1 < chars.length) {
      i += 1;
      c = chars[i];
    }
    i += 1;
    if (chars[i] === '-' && i + 1 < chars.length && chars[i + 1] !== ']') {
      let to = chars[i + 1];
      i += 2;
      if (to === '\\' && i < chars.length) {
        to = chars[i];
        i += 1;
      }
      items.push({ from: c.codePointAt(0), to: to.codePointAt(0) });
    } else {
      items.push({ from: c.codePointAt(0), to: c.codePointAt(0) });
    }
  }
  return null;
}

/** Splits a pattern into segments of tokens, at every `/` outside a bracket expression. */
function tokenize(pattern) {
  const chars = Array.from(pattern);
  const segments = [[]];
  let current = segments[0];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '/' || (c === '\\' && chars[i + 1] === '/')) {
      // An escaped slash still separates, as in git.
      current = [];
      segments.push(current);
      i += c === '/' ? 1 : 2;
    } else if (c === '*') {
      let run = 0;
      while (chars[i] === '*') {
        run += 1;
        i += 1;
      }
      current.push({ type: STAR, run });
    } else if (c === '?') {
      current.push({ type: ANY });
      i += 1;
    } else if (c === '[') {
      const bracket = parseBracket(chars, i);
      if (bracket) {
        current.push(bracket.token);
        i = bracket.next;
      } else {
        current.push({ type: LITERAL, ch: '[' });
        i += 1;
      }
    } else if (c === '\\' && i + 1 < chars.length) {
      current.push({ type: LITERAL, ch: chars[i + 1] });
      i += 2;
    } else {
      current.push({ type: LITERAL, ch: c });
      i += 1;
    }
  }
  return segments;
}

/** A segment's tokens plus what lets a mismatch be ruled out before matching. */
function prepareSegment(tokens) {
  const fixed = tokens.filter((token) => token.type !== STAR).length;
  return { tokens, fixed, hasStar: fixed < tokens.length };
}

function matchToken(token, ch) {
  if (token.type === ANY) return true;
  if (token.type === LITERAL) return token.ch === ch;
  const code = ch.codePointAt(0);
  let hit = false;
  for (const item of token.items) {
    if (item.test ? item.test(ch) : code >= item.from && code <= item.to) {
      hit = true;
      break;
    }
  }
  return hit !== token.negated;
}

/**
 * One segment against one name (an array of characters). Iterative: on a
 * mismatch only the last star takes one more character.
 */
function matchSegment(segment, chars) {
  if (chars.length < segment.fixed || (!segment.hasStar && chars.length !== segment.fixed)) return false;
  const { tokens } = segment;
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < chars.length) {
    steps += 1;
    if (p < tokens.length) {
      const token = tokens[p];
      if (token.type === STAR) {
        p += 1;
        starP = p;
        starT = t;
        continue;
      }
      if (matchToken(token, chars[t])) {
        p += 1;
        t += 1;
        continue;
      }
    }
    if (starP < 0) return false;
    p = starP;
    starT += 1;
    t = starT;
  }
  while (p < tokens.length && tokens[p].type === STAR) p += 1;
  return p === tokens.length;
}

/** A list of segments (with GLOBSTAR entries) against a path's segments — the same algorithm one level up. */
function matchSegments(segments, names) {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < names.length) {
    steps += 1;
    if (p < segments.length) {
      const segment = segments[p];
      if (segment === GLOBSTAR) {
        p += 1;
        starP = p;
        starT = t;
        continue;
      }
      if (matchSegment(segment, names[t])) {
        p += 1;
        t += 1;
        continue;
      }
    }
    if (starP < 0) return false;
    p = starP;
    starT += 1;
    t = starT;
  }
  while (p < segments.length && segments[p] === GLOBSTAR) p += 1;
  return p === segments.length;
}

/** A path, split once for all the patterns it is tested against. */
function preparePath(relPath) {
  const names = String(relPath).split('/').map((name) => Array.from(name));
  return { names, basename: names[names.length - 1] };
}

function matchPrepared(glob, prepared) {
  if (!glob.anchored) return matchSegment(glob.basename, prepared.basename);
  return matchSegments(glob.segments, prepared.names);
}

/**
 * Compiles a glob in gitignore syntax: a trailing `/` means folders only, a
 * `/` at the start or in the middle anchors the pattern at the root, a
 * pattern without one matches the name at any depth.
 *
 * @param {string} pattern
 * @returns {{ dirOnly: boolean, anchored: boolean, test: (relPath: string) => boolean }}
 *   `test` takes a POSIX path relative to the root and leaves `dirOnly` to the caller.
 */
function compileGlob(pattern) {
  let body = String(pattern);
  let dirOnly = false;
  if (body.endsWith('/')) {
    dirOnly = true;
    body = body.slice(0, -1);
  }
  const anchored = body.includes('/');
  if (body.startsWith('/')) body = body.slice(1);
  const raw = tokenize(body);
  const glob = { dirOnly, anchored };
  if (!anchored) {
    // A name never contains `/`, so `**` there is just `*`.
    glob.basename = prepareSegment(raw[0]);
  } else {
    const segments = raw.map((tokens) =>
      tokens.length === 1 && tokens[0].type === STAR && tokens[0].run >= 2 ? GLOBSTAR : prepareSegment(tokens)
    );
    // `x/**` matches what is inside `x`, not `x` itself: at least one segment.
    if (segments[segments.length - 1] === GLOBSTAR) {
      segments.splice(segments.length - 1, 0, prepareSegment([{ type: STAR, run: 1 }]));
    }
    glob.segments = segments;
  }
  glob.test = (relPath) => matchPrepared(glob, preparePath(relPath));
  return glob;
}

/**
 * Drops trailing whitespace unless a backslash escapes it, as git does for
 * spaces (`foo\ ` keeps one). A loop rather than `/\s+$/`, which is
 * quadratic on a long run of blanks that is not at the end.
 */
function trimTrailingBlanks(line) {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t' || line[end - 1] === '\r')) end -= 1;
  if (end === line.length) return line;
  let backslashes = 0;
  while (end - backslashes - 1 >= 0 && line[end - backslashes - 1] === '\\') backslashes += 1;
  return backslashes % 2 === 1 ? line.slice(0, end + 1) : line.slice(0, end);
}

/**
 * Builds a matcher `(relPath, isDirectory) → ignored?` from the text of a
 * `.gitignore`: comments, negation with `!`, folder-only patterns, anchoring,
 * the wildcards above. The last matching rule wins. Returns null when the
 * text holds no rule. Once the matcher has spent `maxSteps`, it ignores
 * nothing more (see `GITIGNORE_MAX_STEPS`).
 *
 * @param {string} text
 * @param {{ maxSteps?: number }} [options]
 */
function createGitignoreMatcher(text, { maxSteps = GITIGNORE_MAX_STEPS } = {}) {
  let source = String(text);
  // git skips a UTF-8 byte order mark; without that the first rule never matches.
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const rules = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = trimTrailingBlanks(rawLine);
    if (!line || line.startsWith('#')) continue;
    let body = line;
    let negated = false;
    if (body.startsWith('!')) {
      negated = true;
      body = body.slice(1);
    }
    if (!body) continue;
    rules.push({ glob: compileGlob(body), negated });
  }
  if (!rules.length) return null;
  let spent = 0;
  return (relPath, isDirectory) => {
    if (spent > maxSteps) return false;
    const before = steps;
    const prepared = preparePath(relPath);
    let ignored = false;
    for (const rule of rules) {
      if (rule.glob.dirOnly && !isDirectory) continue;
      // The last matching rule wins, so a rule that could not change the
      // answer need not be tried.
      if (ignored !== !rule.negated && matchPrepared(rule.glob, prepared)) ignored = !rule.negated;
    }
    spent += steps - before;
    return ignored;
  };
}

module.exports = { GITIGNORE_MAX_STEPS, compileGlob, createGitignoreMatcher };
