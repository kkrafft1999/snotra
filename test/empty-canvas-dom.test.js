// The deck chair that fills the empty area when every column is hidden (#315).
//
// Two things are worth holding onto here, and neither of them is layout:
//
//   * The drawing is decoration. It must stay out of the accessibility tree
//     and out of the tab order, whatever else changes around it.
//   * It appears under one condition only — all four columns off. That
//     condition lives in a CSS selector, so the selector is what is checked.
//
// happy-dom has no layout and does not load the stylesheet (see
// test/helpers/dom.js), so "is it visible" cannot be asked here. The running
// app answers that in e2e/smoke.test.mjs; this file guards the contract
// between markup, stylesheet and asset — a renamed class or a moved file
// breaks a test instead of quietly emptying the area again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupRendererDom } = require('./helpers/dom.js');

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
const STYLES = fs.readFileSync(path.join(RENDERER_DIR, 'styles.css'), 'utf8');

test('the drawing sits in #app and says nothing to a screen reader', () => {
  const dom = setupRendererDom();
  try {
    const canvas = dom.document.getElementById('empty-canvas');
    assert.ok(canvas, '#empty-canvas is missing from index.html');
    assert.equal(canvas.getAttribute('aria-hidden'), 'true');
    assert.equal(canvas.hasAttribute('tabindex'), false, 'decoration must not be a tab stop');
    assert.equal(canvas.textContent.trim(), '', 'no text, hence nothing to translate');
    assert.equal(canvas.children.length, 0, 'the drawing comes from CSS, not from the DOM');

    const app = dom.document.getElementById('app');
    assert.equal(canvas.parentElement, app, 'it has to be a child of #app to fill the row');
    assert.equal(app.lastElementChild, canvas, 'and the last one, behind both halves');
  } finally {
    dom.cleanup();
  }
});

test('it is hidden by default and shown only with all four columns off', () => {
  assert.match(STYLES, /#empty-canvas\s*\{\s*display:\s*none;/,
    'without the four classes the area stays empty');

  const shown = STYLES.match(
    /#app\.app--no-sidebar\.app--no-preview\.app--no-chat\.app--no-history #empty-canvas \{[^}]*\}/
  );
  assert.ok(shown, 'the selector must demand all four hidden columns');
  assert.match(shown[0], /display:\s*flex;/);

  const before = STYLES.match(
    /#app\.app--no-sidebar\.app--no-preview\.app--no-chat\.app--no-history #empty-canvas::before \{[^}]*\}/
  );
  assert.ok(before, 'the mask hangs on ::before, not on the element itself');
  assert.match(before[0], /mask:\s*url\('\.\/assets\/empty-canvas\.svg'\)/);
  assert.match(before[0], /-webkit-mask:/, 'Chromium still wants the prefixed property');
  assert.match(before[0], /height:\s*min\(100%,\s*440px\)/, 'the drawing has to stay bounded');
  assert.match(before[0], /background-color:\s*var\(--empty-canvas-ink\)/);
});

test('the ink is a token and exists in both themes', () => {
  const light = STYLES.match(/:root \{[\s\S]*?\n\}/);
  const dark = STYLES.match(/\[data-theme="dark"\] \{[\s\S]*?\n\}/);
  assert.ok(light && dark);
  assert.match(light[0], /--empty-canvas-ink:\s*color-mix\(/, 'light mode defines the ink');
  assert.match(dark[0], /--empty-canvas-ink:\s*color-mix\(/, 'dark mode redefines it');
});

test('the asset is there, is a mask, and carries no text', () => {
  const file = path.join(RENDERER_DIR, 'assets', 'empty-canvas.svg');
  const svg = fs.readFileSync(file, 'utf8');
  assert.match(svg, /<svg[^>]*viewBox="[^"]+"/, 'a viewBox, otherwise contain has nothing to scale');
  assert.equal(/<text[\s>]/.test(svg), false, 'no text in the picture, nothing to translate');
  assert.equal(/<image[\s>]|xlink:href/.test(svg), false, 'vector only, no embedded bitmap');
  assert.equal(/https?:\/\//.test(svg.replace(/xmlns="[^"]*"/g, '')), false,
    'nothing may be loaded from the network');
});
