// Style rules of Settings › MCP that a DOM test cannot see (CR-B14-09).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

function block(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} not found`);
  return styles.slice(start, styles.indexOf('}', start));
}

test('a long unbroken server name wraps instead of overflowing its row', () => {
  for (const selector of ['.mcp-row__name', '.mcp-import__name']) {
    assert.match(block(selector), /overflow-wrap:\s*anywhere/, selector);
  }
});

// Red is reserved for errors (ui-design-tokens.md); "replaces" and "check"
// ask for a decision, nothing has failed.
test('the import badges that ask for a decision are not red', () => {
  const warn = block('.mcp-import__badge--warn');
  assert.doesNotMatch(warn, /--ds-error/);
  assert.match(warn, /background:\s*var\(--text-primary\)/);
});

test('the per-server tool list styles are gone with the list (#449)', () => {
  assert.doesNotMatch(styles, /\.mcp-tool-(list|row)\b/);
});
