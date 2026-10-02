// Colours live in tokens.css, styles.css only refers to them (CR-B15-05).
//
// `.claude/rules/ui-design-tokens.md` has two layers: every colour value is a
// token in `styles/tokens.css`, and `styles.css` adds aliases that map onto
// those tokens — "never hex values directly in a component". A second grey
// scale of eighteen hex values had grown at the top of styles.css, out of
// reach of the token comments and their contrast figures. This keeps it out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const COLOUR_VALUE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;

test('styles.css declares no colour value of its own', () => {
  const offenders = [];
  // Innermost blocks only, so a rule inside @media is checked as well; the
  // selector stays out of it — `#add-model` is an id, not a colour.
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const declaration of body.split(';')) {
      if (COLOUR_VALUE.test(declaration)) {
        offenders.push(`${selector.trim().replace(/\s+/g, ' ')} → ${declaration.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a colour value belongs in styles/tokens.css');
});
