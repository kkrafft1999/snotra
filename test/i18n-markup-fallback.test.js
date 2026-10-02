// The English text in index.html is a second copy of the catalogue (CR-B15-01).
//
// Every `data-i18n` element carries a fallback for the first paint, and until
// CR-B15-01 an English start never replaced it — four of them had drifted from
// `en.js` without anybody seeing it, one of them a statement about what leaves
// the machine. The start now paints the catalogue over the markup in every
// language; this test keeps the fallback honest for the moment before that,
// and for a start whose preferences cannot be read.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Window } = require('happy-dom');

const { MESSAGES } = require('../src/shared/i18n');
const { loadRendererMarkup } = require('./helpers/dom');

const en = MESSAGES.en;

// Markup is wrapped and indented, the catalogue is one line: compare the
// words, not the layout. Whitespace next to a paragraph tag carries nothing.
const normalize = (html) => html.replace(/\s+/g, ' ').replace(/\s*(<\/?p>)\s*/g, '$1').trim();

function load() {
  const window = new Window({ url: 'http://localhost/' });
  window.document.write(loadRendererMarkup());
  return window;
}

test('every static text in index.html is the English catalogue entry', (t) => {
  const window = load();
  t.after(() => window.close());
  const { document } = window;
  const differs = [];

  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (normalize(el.textContent) !== normalize(en[key] ?? '')) differs.push(`data-i18n ${key}`);
  }
  const parsed = document.createElement('div');
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    const key = el.getAttribute('data-i18n-html');
    parsed.innerHTML = en[key] ?? '';
    if (normalize(el.innerHTML) !== normalize(parsed.innerHTML)) differs.push(`data-i18n-html ${key}`);
  }
  for (const el of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
      const sep = pair.indexOf(':');
      const attr = pair.slice(0, sep).trim();
      const key = pair.slice(sep + 1).trim();
      if (el.getAttribute(attr) !== en[key]) differs.push(`data-i18n-attr ${attr}:${key}`);
    }
  }

  assert.deepEqual(differs, [], 'the markup says something else than en.js');
});
