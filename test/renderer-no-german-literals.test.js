// Guard against German text that bypasses i18n in the renderer components (#374).
//
// `i18n-keys.test.js` keeps both dictionaries in step, but it cannot see a
// literal that never went through `t()` — which is how "geheim" and "Modus"
// reached the English interface. This check is deliberately rough: it strips
// comments and flags any string literal with a German umlaut or ß. A German
// word without one slips through; the cheap check still catches most.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMPONENTS_DIR = path.join(__dirname, '..', 'src', 'renderer', 'components');
const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const GERMAN_LETTER = /[äöüÄÖÜß]/;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

test('no string literal in src/renderer/components carries German umlauts', () => {
  const hits = [];
  for (const file of fs.readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith('.js'))) {
    const source = stripComments(fs.readFileSync(path.join(COMPONENTS_DIR, file), 'utf8'));
    for (const [literal] of source.matchAll(STRING_LITERAL)) {
      if (GERMAN_LETTER.test(literal)) hits.push(`${file}: ${literal.slice(0, 80)}`);
    }
  }
  assert.deepEqual(hits, [], 'user-facing text belongs in the i18n dictionaries, log output in English');
});
