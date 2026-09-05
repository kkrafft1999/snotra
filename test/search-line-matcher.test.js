const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SEARCH_MAX_PATTERN_CHARS,
  collectLineMatches,
  validateRegexPattern,
} = require('../src/main/services/search-line-matcher');

test('validateRegexPattern rejects nested unbounded quantifiers (ReDoS class)', () => {
  for (const pattern of ['(a+)+!', '(\\w*\\s?)*', '((ab)*c)+', '(a{2,})+', '(?:x+)*?', '(a|b+)*']) {
    assert.match(validateRegexPattern(pattern) || '', /zu komplex/, `sollte abgelehnt werden: ${pattern}`);
  }
});

test('validateRegexPattern accepts common safe patterns', () => {
  for (const pattern of [
    'foo\\d+',
    '(\\d{1,3}\\.){3}\\d{1,3}',
    '[a+]+',
    '\\(a+\\)+',
    '(a+){2}',
    '^(import|export)\\s+.*from',
    'TODO|FIXME',
    '(?<=\\$)\\w+',
    '[^]]+',
  ]) {
    assert.equal(validateRegexPattern(pattern), null, `sollte akzeptiert werden: ${pattern}`);
  }
});

test('validateRegexPattern enforces the pattern length limit', () => {
  assert.equal(validateRegexPattern('a'.repeat(SEARCH_MAX_PATTERN_CHARS)), null);
  assert.match(validateRegexPattern('a'.repeat(SEARCH_MAX_PATTERN_CHARS + 1)), /zu lang/);
  assert.match(validateRegexPattern('abc', { maxChars: 2 }), /zu lang/);
});

test('collectLineMatches returns context, clips output and probes only the line prefix', () => {
  const text = 'eins\nzwei treffer\ndrei\nvier';
  assert.deepEqual(
    collectLineMatches(text, /treffer/, { contextLines: 1, maxMatches: 10, matchLineChars: 100, clipChars: 400 }),
    [{ line: 2, text: 'zwei treffer', before: ['eins'], after: ['drei'] }]
  );

  const longLine = `${'x'.repeat(20)}treffer`;
  assert.deepEqual(
    collectLineMatches(longLine, /treffer/, { contextLines: 0, maxMatches: 10, matchLineChars: 10, clipChars: 400 }),
    [],
    'Treffer jenseits der geprüften Zeilenlänge werden nicht gefunden'
  );
  const clipped = collectLineMatches(longLine, /treffer/, {
    contextLines: 0,
    maxMatches: 10,
    matchLineChars: 100,
    clipChars: 5,
  });
  assert.equal(clipped[0].text, 'xxxxx…');

  const many = collectLineMatches('a\na\na\na', /a/, { contextLines: 0, maxMatches: 2, matchLineChars: 100, clipChars: 400 });
  assert.equal(many.length, 2);
});
