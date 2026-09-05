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
