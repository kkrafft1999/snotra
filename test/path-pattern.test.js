// Pfadmuster mit definierter `*`/`**`-Semantik (Issue #66, Konzept §7).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePathForMatch,
  compilePathPattern,
  matchesPathPattern,
} = require('../src/shared/runtime/path-pattern');

test('normalizePathForMatch vereinheitlicht Trenner, ./ und Rand-Slashes', () => {
  assert.equal(normalizePathForMatch('./a\\b//c/'), 'a/b/c');
  assert.equal(normalizePathForMatch('/a/./b'), 'a/b');
  assert.equal(normalizePathForMatch(''), '');
  assert.equal(normalizePathForMatch(42), '');
});

test('* bleibt im Segment, ** überspannt Segmente', () => {
  const cases = [
    ['**', 'a/b/c', true],
    ['*.pem', 'certs/x.pem', true],
    ['*.pem', 'x.pemx', false],
    ['src/*', 'src/a.js', true],
    ['src/*', 'src/a/b.js', false],
    ['src/**', 'src/a/b.js', true],
    ['src/**', 'src', true],
    ['src/**', 'srcx', false],
    ['**/*.md', 'a/b/c.md', true],
    ['**/*.md', 'c.md', true],
    ['docs/**/*.md', 'docs/x/y.md', true],
    ['docs/**/*.md', 'docs/y.md', true],
    ['docs/**/*.md', 'doc/y.md', false],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['**/x', 'x', true],
    ['**/x', 'q/x', true],
    ['personal', 'personal/x', false],
    ['personal/**', 'personal/x', true],
    ['personal/**', 'personality', false],
  ];
  for (const [pattern, file, expected] of cases) {
    assert.equal(matchesPathPattern(pattern, file), expected, `${pattern} ~ ${file}`);
  }
});

test('Muster ohne / gelten für den Dateinamen an jeder Stelle, Muster mit / sind verankert', () => {
  assert.equal(matchesPathPattern('id_*', 'home/.ssh/id_rsa'), true);
  assert.equal(matchesPathPattern('id_*', 'identity.js'), false);
  assert.equal(matchesPathPattern('src/a.js', 'x/src/a.js'), false);
  assert.equal(compilePathPattern('src/**').anchored, true);
  assert.equal(compilePathPattern('*.key').anchored, false);
});

test('Sonderzeichen außer * sind wörtlich; Groß-/Kleinschreibung nur auf Wunsch egal', () => {
  assert.equal(matchesPathPattern('a.b', 'aXb'), false);
  assert.equal(matchesPathPattern('(x)+', '(x)+'), true);
  assert.equal(matchesPathPattern('A/B', 'a/b'), false);
  assert.equal(matchesPathPattern('A/B', 'a/b', { caseInsensitive: true }), true);
  assert.equal(matchesPathPattern('.ENV*', 'config/.env.local', { caseInsensitive: true }), true);
});

test('Windows-Trenner im Pfad werden wie / behandelt', () => {
  assert.equal(matchesPathPattern('src/**', 'src\\lib\\a.js'), true);
  assert.equal(matchesPathPattern('*.key', 'keys\\server.key'), true);
});

test('many stars in one segment match in linear time (CR-B17-10)', () => {
  const pattern = `${'*a'.repeat(30)}*b`;
  const name = 'a'.repeat(255);
  const started = Date.now();
  assert.equal(matchesPathPattern(pattern, name), false);
  assert.equal(matchesPathPattern(`x/**/${pattern}`, `x/${'y/'.repeat(50)}${name}`), false);
  assert.equal(matchesPathPattern(pattern, `${name}b`), true);
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
});

test('the compiled matcher takes a normalized path and keeps anchored and matchesSelf', () => {
  const compiled = compilePathPattern('Personal/**', { caseInsensitive: true });
  assert.equal(compiled.test('personal/notes.md'), true);
  assert.equal(compiled.test('personal'), true);
  assert.equal(compiled.test('personality'), false);
  assert.equal(compiled.anchored, true);
  assert.equal(compiled.matchesSelf, true);
  assert.equal(compilePathPattern('').test('anything/at/all'), true);
});

/**
 * The regular expression the patterns were compiled to until CR-B17-10, kept
 * as the reference the new matcher has to agree with.
 */
function referenceRegex(rawPattern, caseInsensitive) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = normalizePathForMatch(rawPattern);
  if (!pattern || pattern === '**') return /^.*$/;
  const anchored = pattern.includes('/');
  const segments = pattern.split('/');
  let source = '';
  let previousWasMiddleAny = false;
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      if (isLast) source += '(?:/.*)?';
      else {
        if (source && !previousWasMiddleAny) source += '/';
        source += '(?:[^/]+/)*';
      }
      previousWasMiddleAny = !isLast;
      return;
    }
    if (source && !previousWasMiddleAny) source += '/';
    source += segment.split('*').map(escape).join('[^/]*');
    previousWasMiddleAny = false;
  });
  return new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${source}$`, caseInsensitive ? 'i' : '');
}

test('the matcher agrees with the former regular expression (CR-B17-10)', () => {
  // A fixed-seed generator, so a failure is reproducible.
  let seed = 0x5eed;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = ['a', 'b', 'A', '.', '*', '**', '/', 'x'];
  const make = (maxLength, withStars) => {
    let text = '';
    const length = next(maxLength);
    for (let i = 0; i < length; i += 1) text += alphabet[next(alphabet.length)];
    return withStars ? text : text.replace(/\*/g, '');
  };
  let compared = 0;
  for (let i = 0; i < 20000; i += 1) {
    const pattern = make(8, true);
    // Consecutive `**` is where the regex was wrong: `**/**` missed `x`.
    if (/\*\*\/\*\*/.test(normalizePathForMatch(pattern))) continue;
    const file = make(10, false);
    for (const caseInsensitive of [false, true]) {
      const expected = referenceRegex(pattern, caseInsensitive).test(normalizePathForMatch(file));
      assert.equal(matchesPathPattern(pattern, file, { caseInsensitive }), expected, `${pattern} ~ ${file}`);
      compared += 1;
    }
  }
  assert.ok(compared > 30000);
  assert.equal(matchesPathPattern('**/**', 'x'), true);
});
