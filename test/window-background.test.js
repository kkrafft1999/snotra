'use strict';

// The window's background is the light surface token, not pure white (#509).
// window.js needs Electron, so the value is read from its source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

test('the window background is --ds-surface of the light theme', () => {
  const windowSource = fs.readFileSync(path.join(root, 'src/main/window.js'), 'utf8');
  const tokens = fs.readFileSync(path.join(root, 'src/renderer/styles/tokens.css'), 'utf8');
  const background = /const WINDOW_BACKGROUND = '(#[0-9A-Fa-f]{6})';/.exec(windowSource)?.[1];
  const lightRoot = tokens.slice(tokens.indexOf(':root'), tokens.indexOf("[data-theme='dark']"));
  const surface = /--ds-surface:\s*(#[0-9A-Fa-f]{6});/.exec(lightRoot)?.[1];
  assert.ok(background, 'WINDOW_BACKGROUND is set in window.js');
  assert.ok(surface, '--ds-surface is set for the light theme');
  assert.equal(background.toLowerCase(), surface.toLowerCase());
});

test('the window is shown only once the page has painted', () => {
  const windowSource = fs.readFileSync(path.join(root, 'src/main/window.js'), 'utf8');
  assert.match(windowSource, /show: false,/);
  assert.match(windowSource, /once\('ready-to-show'/);
});
