'use strict';

// Addresses on docs.snotra-ai.dev, both ways (#947): what the model hands on
// and what a click in the chat opens in the help window.

const test = require('node:test');
const assert = require('node:assert/strict');
const { manualWebUrl, parseManualAddress, MANUAL_WEB_BASE } = require('../src/shared/manual/manual-address');

test('an address names the page, the section and the language', () => {
  assert.deepEqual(parseManualAddress('https://docs.snotra-ai.dev/safety/sandbox/'), { slug: 'safety/sandbox', fragment: '', locale: null });
  assert.deepEqual(parseManualAddress('https://docs.snotra-ai.dev/de/safety/sandbox/#eine-datei-au%C3%9Ferhalb'),
    { slug: 'safety/sandbox', fragment: 'eine-datei-außerhalb', locale: 'de' });
  assert.deepEqual(parseManualAddress('https://docs.snotra-ai.dev/'), { slug: 'index', fragment: '', locale: null });
  assert.deepEqual(parseManualAddress('https://docs.snotra-ai.dev/de/'), { slug: 'index', fragment: '', locale: 'de' });
  assert.deepEqual(parseManualAddress('https://docs.snotra-ai.dev/safety/sandbox'), { slug: 'safety/sandbox', fragment: '', locale: null });
});

test('anything that is not a page of the web manual is not one', () => {
  for (const href of [
    'http://docs.snotra-ai.dev/safety/sandbox/',
    'https://docs.snotra-ai.dev:8443/safety/sandbox/',
    'https://user@docs.snotra-ai.dev/safety/sandbox/',
    'https://docs.snotra-ai.dev.example.com/safety/sandbox/',
    'https://snotra-ai.dev/safety/sandbox/',
    'https://docs.snotra-ai.dev/Safety/Sandbox/',
    'https://docs.snotra-ai.dev/a%20b/',
    'https://docs.snotra-ai.dev/%E0%A4%A/',
    'safety/sandbox',
    'mailto:a@example.com',
    '',
    null,
  ]) {
    assert.equal(parseManualAddress(href), null, String(href));
  }
});

test('an address made from a page reads back as that page', () => {
  assert.equal(MANUAL_WEB_BASE, 'https://docs.snotra-ai.dev/');
  for (const [locale, slug, fragment] of [['en', 'index', ''], ['de', 'safety/sandbox', 'was-du-brauchst'], ['en', 'reference/keyboard-shortcuts', 'chat']]) {
    const parsed = parseManualAddress(manualWebUrl(locale, slug, fragment));
    assert.deepEqual(parsed, { slug, fragment, locale: locale === 'de' ? 'de' : null });
  }
});
