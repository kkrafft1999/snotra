const test = require('node:test');
const assert = require('node:assert/strict');
const { extractStringFromPartialJson } = require('../src/shared/runtime/partial-json');

test('extractStringFromPartialJson liefert den Wert erst, wenn er komplett ist', () => {
  assert.equal(extractStringFromPartialJson('{"relative_', 'relative_path'), null);
  assert.equal(extractStringFromPartialJson('{"relative_path":"docs/ne', 'relative_path'), null);
  assert.equal(extractStringFromPartialJson('{"relative_path":"docs/neu.md","content":"Hal', 'relative_path'), 'docs/neu.md');
  assert.equal(extractStringFromPartialJson('{ "relative_path" : "a b.txt" }', 'relative_path'), 'a b.txt');
});

test('extractStringFromPartialJson dekodiert JSON-Escapes und ignoriert fremde Schlüssel', () => {
  assert.equal(extractStringFromPartialJson('{"query":"sag \\"hallo\\" \\u00e4"', 'query'), 'sag "hallo" ä');
  assert.equal(extractStringFromPartialJson('{"pattern":"**/*.md"}', 'relative_path'), null);
  assert.equal(extractStringFromPartialJson('{"relative_path":42}', 'relative_path'), null);
});

test('extractStringFromPartialJson ist robust gegen ungültige Eingaben', () => {
  assert.equal(extractStringFromPartialJson(undefined, 'relative_path'), null);
  assert.equal(extractStringFromPartialJson('{"a":"b"}', ''), null);
  assert.equal(extractStringFromPartialJson('{"a.b":"c"}', 'a.b'), 'c');
});
