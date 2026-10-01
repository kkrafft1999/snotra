// The import dialog's small secondary texts reach 4.5:1 in both themes
// (CR-B14-08, WCAG 1.4.3). `--ds-grey-muted` is only allowed from 14px on;
// below that the texts take `--ds-grey-strong`, and the ratio is computed
// from tokens.css, so a later change to either value is caught here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const styles = fs.readFileSync(path.join(RENDERER, 'styles.css'), 'utf8');
const tokens = fs.readFileSync(path.join(RENDERER, 'styles', 'tokens.css'), 'utf8');

function block(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} not found`);
  return source.slice(start, source.indexOf('}', start));
}

function token(scope, name) {
  const match = block(tokens, scope).match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
  assert.ok(match, `${name} in ${scope}`);
  return match[1];
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SMALL_TEXTS = ['.mcp-import__count', '.mcp-import__id', '.mcp-import__cmd', '.mcp-import__skipped ul'];

test('the small texts of the MCP import use --ds-grey-strong', () => {
  for (const selector of SMALL_TEXTS) {
    assert.match(block(styles, selector), /color:\s*var\(--ds-grey-strong\)/, selector);
  }
});

test('--ds-grey-strong reaches 4.5:1 on the surfaces of the import, light and dark', () => {
  for (const scope of [':root', "[data-theme='dark']"]) {
    const ink = token(scope, '--ds-grey-strong');
    for (const ground of ['--ds-surface', '--ds-grey-card']) {
      const ratio = contrast(ink, token(scope, ground));
      assert.ok(ratio >= 4.5, `${scope} ${ground}: ${ratio.toFixed(2)}:1`);
    }
  }
});
