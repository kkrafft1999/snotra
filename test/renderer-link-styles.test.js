// Grundregel fuer Links (Issue #105).
//
// Ohne eigene Farbregel erben Links das Browser-Blau (#0000EE, besucht
// #551A8B). Im Dunkelmodus sind das rund 1,7:1 auf --ds-grey-bg — unlesbar.
// Der Test haelt die Regel im Stylesheet fest, samt Token-Bezug: Hex-Werte
// gehoeren nach tokens.css, nicht in eine Komponente
// (.claude/rules/ui-design-tokens.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const tokens = fs.readFileSync(path.join(rendererDir, 'styles', 'tokens.css'), 'utf8');

/** Deklarationen einer Regel, an ihrem Selektor gesucht. */
function declarations(selector) {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `Regel „${selector}“ fehlt in styles.css`);
  return css.slice(at, css.indexOf('}', at));
}

test('Links tragen die Akzentfarbe und sind unterstrichen', () => {
  const rule = declarations('a,\na:visited');
  assert.match(rule, /color:\s*var\(--accent-text\)/);
  // Farbe allein reicht nicht, um einen Link zu erkennen (WCAG 1.4.1).
  assert.match(rule, /text-decoration:\s*underline/);
});

test('der Hover-Zustand nutzt die dunklere Akzentstufe', () => {
  assert.match(declarations('a:hover'), /color:\s*var\(--accent-hover\)/);
});

test('die Link-Regeln enthalten keine eigenen Farbwerte', () => {
  for (const selector of ['a,\na:visited', 'a:hover']) {
    assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(declarations(selector)), false, selector);
  }
});

test('die Akzent-Aliase sind in beiden Themes belegt', () => {
  assert.match(css, /--accent-text:\s*var\(--ds-blue\)/);
  assert.match(css, /--accent-hover:\s*var\(--ds-btn-primary-bg-hover\)/);
  const dark = tokens.slice(tokens.indexOf("[data-theme='dark']"));
  assert.match(dark, /--ds-blue:\s*#[0-9A-Fa-f]{6}/, 'Dark-Mode definiert --ds-blue neu');
  assert.match(dark, /--ds-btn-primary-bg-hover:\s*#[0-9A-Fa-f]{6}/);
});
