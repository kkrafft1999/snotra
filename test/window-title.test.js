// The native window title names the open workspace (#676).

const test = require('node:test');
const assert = require('node:assert/strict');
const { windowTitle } = require('../src/main/services/window-title');

test('the renderer\'s title is taken over, with the version after it', () => {
  assert.equal(windowTitle('snotra — Snotra AI', '1.13.5'), 'snotra — Snotra AI 1.13.5');
});

test('without a folder the title is the brand and the version, as before', () => {
  assert.equal(windowTitle('Snotra AI', '1.13.5'), 'Snotra AI 1.13.5');
});

test('an empty title falls back to the brand', () => {
  assert.equal(windowTitle('', '1.13.5'), 'Snotra AI 1.13.5');
  assert.equal(windowTitle(undefined, ''), 'Snotra AI');
});
