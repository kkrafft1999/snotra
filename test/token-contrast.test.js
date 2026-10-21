// Contrast over the design tokens (#999, AR-24).
//
// Every ink the system defines, on every ground it is meant to stand on, in
// the light and in the dark theme, computed from tokens.css itself — so a
// change to any value is caught here, not by eye. The pairs are the rules of
// .claude/rules/ui-design-tokens.md written out: which grey may stand where,
// which status colour on which tint. A pair that is not listed is not allowed
// by those rules either; adding a use means adding its pair here.
//
// Text needs 4.5:1 (WCAG 1.4.3), the edges and rings that make a control
// visible need 3:1 (1.4.11). A translucent ground — a wash, a tint — is laid
// over the ground it sits on before the ratio is taken, the way the browser
// paints it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TOKENS = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'tokens.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(selector) {
  const start = TOKENS.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} not found in tokens.css`);
  const body = TOKENS.slice(start, TOKENS.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const ROOT = declarations(':root');
// `data-theme` sits on the root element itself, so the dark block overrides
// the light one and every var() resolves against the merged set.
const THEMES = { light: ROOT, dark: { ...ROOT, ...declarations("[data-theme='dark']") } };

/** A token's colour as [r, g, b, a], channels 0–255, alpha 0–1. */
function colour(theme, name, seen = []) {
  const value = THEMES[theme][name];
  assert.ok(value, `${name} is not defined (${theme})`);
  assert.ok(!seen.includes(name), `${name} refers to itself`);
  const ref = value.match(/^var\((--[a-z0-9-]+)\)$/);
  if (ref) return colour(theme, ref[1], [...seen, name]);
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const rgba = value.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  if (rgba) return rgba.slice(1, 4).map(Number).concat(Number(rgba[4]));
  throw new Error(`${name}: cannot read "${value}" as a colour (${theme})`);
}

/** Lays a translucent colour over an opaque one. */
function over([r, g, b, a], [R, G, B]) {
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
}

/** A ground: one token, or a tint over another ground (`['--wash', '--base']`). */
function ground(theme, spec) {
  if (typeof spec === 'string') {
    const c = colour(theme, spec);
    assert.equal(c[3], 1, `${spec} is translucent; name the ground it lies on (${theme})`);
    return c;
  }
  const [tint, base] = spec;
  return over(colour(theme, tint), ground(theme, base));
}

function luminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const NON_TEXT = 3;

// The grounds of the app, by role.
const PANEL_GROUNDS = ['--ds-surface', '--ds-grey-bg', '--ds-grey-card', '--ds-bg-secondary', '--ds-bg-header'];
const HOVER_GROUNDS = ['--ds-bg-tertiary', '--ds-bg-hover'];
const CHAT_GROUNDS = ['--ds-chat-bg', '--ds-chat-composer-bg'];
const ALL_GROUNDS = [...PANEL_GROUNDS, ...HOVER_GROUNDS, '--ds-bg-active', ...CHAT_GROUNDS];

/**
 * [ink, grounds, minimum, why]. Each ground is a token or [tint, ground].
 * Where a ground is left out on purpose, the reason is in `why`.
 */
const PAIRS = [
  ['--ds-text-primary', ALL_GROUNDS, TEXT, 'body text, everywhere'],
  ['--ds-text-secondary', [...PANEL_GROUNDS, ...HOVER_GROUNDS, '--ds-chat-bg'], TEXT,
    'secondary text; not on --ds-bg-active, and in dark not on the composer (tokens.css)'],
  ['--ds-grey-muted', ['--ds-surface', '--ds-grey-bg', '--ds-chat-bg'], TEXT,
    'small secondary text only where it keeps headroom (#610)'],
  ['--ds-grey-strong', ALL_GROUNDS, TEXT, 'small secondary text on every other ground (#610)'],
  ['--ds-placeholder', ['--ds-surface', '--ds-chat-composer-bg'], TEXT, 'placeholders, in fields and the composer'],
  ['--ds-dictation-text', ['--ds-chat-composer-bg'], TEXT, 'the dictation line in the composer'],
  ['--ds-blue', ['--ds-surface', '--ds-chat-bg', '--ds-chat-composer-bg', ['--ds-blue-soft', '--ds-surface']], TEXT,
    'links and blue text; on a wash over grey it takes --ds-blue-strong'],
  ['--ds-blue-strong', ['--ds-surface', '--ds-grey-bg', ['--ds-blue-soft', '--ds-grey-bg']], TEXT,
    'blue text on a wash over a grey ground (CR-B15-03)'],
  ['--ds-btn-primary-fg', ['--ds-btn-primary-bg', '--ds-btn-primary-bg-hover'], TEXT, 'primary button and send'],
  ['--ds-btn-destructive-fg', ['--ds-btn-destructive-bg', '--ds-btn-destructive-bg-hover'], TEXT, 'destructive button'],
  ['--ds-error', ['--ds-surface', '--ds-chat-bg', ['--ds-error-bg', '--ds-surface'], ['--ds-error-bg', '--ds-chat-bg']], TEXT,
    'error text and the error bubble'],
  ['--ds-warning', ['--ds-surface', ['--ds-warning-bg', '--ds-surface'], ['--ds-warning-bg', '--ds-chat-composer-bg']], TEXT,
    '"not isolated" (#396)'],
  ['--ds-text-primary', [['--ds-chat-user-bg', '--ds-chat-bg'], ['--ds-diff-added-bg', '--ds-surface']], TEXT,
    'the user bubble and an added line'],
  ['--ds-grey-strong', [['--ds-diff-added-bg', '--ds-surface']], TEXT, 'line numbers of an added line (#348)'],
  ['--ds-blue-strong', [['--ds-diff-added-bg', '--ds-surface']], TEXT, 'the sign of an added line (#348)'],
  ['--ds-blue-strong', [['--ds-warning-bg', '--ds-surface']], TEXT, '"Saved" on the sandbox tile while it is off (#1119)'],
  ['--ds-text-secondary', ['--ds-diff-removed-bg'], TEXT, 'a removed line (#348)'],
  ...['keyword', 'tag', 'string', 'comment', 'number', 'function', 'type', 'property', 'punctuation']
    .map((role) => [`--ds-syntax-${role}`, ['--ds-surface'], TEXT, 'source text in the preview (#745)']),
  ['--ds-paper-ink', ['--ds-paper'], TEXT, 'the note on a page that could not be drawn (#641)'],
  ['--ds-qr-ink', ['--ds-qr-plate'], TEXT, 'the pairing QR code, light in both themes so a camera reads it (#1110)'],
  ['--ds-grey-control-border', ['--ds-surface', '--ds-grey-bg'], NON_TEXT, 'edges of switches and fields'],
  ['--ds-blue', ['--ds-surface', '--ds-grey-bg', ...CHAT_GROUNDS], NON_TEXT, 'the focus ring and an active control'],
  ['--ds-mic-recording', ['--ds-chat-composer-bg'], NON_TEXT, 'the recording microphone'],
];

const label = (spec) => (typeof spec === 'string' ? spec : `${spec[0]} over ${spec[1]}`);

for (const theme of Object.keys(THEMES)) {
  test(`every ink reaches its minimum on the grounds it is meant for (${theme})`, () => {
    const failures = [];
    for (const [ink, grounds, minimum, why] of PAIRS) {
      const fg = colour(theme, ink);
      assert.equal(fg[3], 1, `${ink} is translucent (${theme})`);
      for (const spec of grounds) {
        const value = ratio(fg, ground(theme, spec));
        if (value < minimum) failures.push(`${ink} on ${label(spec)}: ${value.toFixed(2)}:1, needs ${minimum}:1 — ${why}`);
      }
    }
    assert.deepEqual(failures, []);
  });
}

test('every colour token of the light set is read by one rule or the other', () => {
  // Not a contrast check — a guard that this file keeps up with tokens.css: a
  // new ink or ground must be placed in PAIRS, or named here as neither.
  const NEITHER = new Set([
    // Edges, washes and tints: read as a ground in PAIRS or not text at all.
    '--ds-blue-soft', '--ds-blue-border', '--ds-chat-user-bg', '--ds-black', '--ds-white',
    '--ds-grey-divider', '--ds-error-bg', '--ds-error-border', '--ds-warning-bg', '--ds-warning-border',
    '--ds-diff-added-bg', '--ds-diff-added-bar', '--ds-diff-removed-bar', '--ds-mic-recording-bg',
    '--ds-overlay-border', '--ds-checker-light', '--ds-checker-dark', '--ds-paper-ground', '--ds-border',
    '--ds-scrollbar-thumb', '--ds-backdrop', '--ds-backdrop-nested', '--ds-chat-composer-border',
    '--ds-tool-shimmer-highlight',
  ]);
  const used = new Set(PAIRS.flatMap(([ink, grounds]) => [ink, ...grounds.flat()]));
  const colours = Object.entries(ROOT)
    .filter(([, value]) => /^(#|rgba\(|var\(--ds-)/.test(value))
    .map(([name]) => name);
  const unplaced = colours.filter((name) => !used.has(name) && !NEITHER.has(name));
  assert.deepEqual(unplaced, []);
});
