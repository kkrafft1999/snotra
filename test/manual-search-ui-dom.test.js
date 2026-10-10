// The search field of the help window (#847): ↑, ↓ and Enter act on the
// results for what is in the field, also when they are pressed before the
// results for the last keystrokes are drawn (#854). On a slow machine the
// letters of a word come more than the input delay apart, so the list shows
// the hits for "sand" while "sandbox" is still being searched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');
const { RENDERER_DIR, importRenderer, setupRendererDom } = require('./helpers/dom.js');

const PAGES = [
  { slug: 'sanity', title: 'Sanity', markdown: 'Nothing else here.' },
  { slug: 'sandbox', title: 'Sandbox', markdown: 'About the sandbox.' },
  { slug: 'modes', title: 'Modes', markdown: 'The sandbox keeps you safe.' },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
  const markup = fs.readFileSync(path.join(RENDERER_DIR, 'manual.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const dom = setupRendererDom({ markup });
  const { document } = dom;
  dom.window.marked = marked;
  const { createManualSearch } = await importRenderer('manual', 'manual-search-ui.js');
  const opened = [];
  const els = {
    searchInput: document.getElementById('manual-search'),
    searchKey: document.getElementById('manual-search-key'),
    resultsPanel: document.getElementById('manual-results-panel'),
    resultsCount: document.getElementById('manual-results-count'),
    results: document.getElementById('manual-results'),
    nav: document.getElementById('manual-nav'),
  };
  createManualSearch({
    els,
    api: { pages: async () => PAGES },
    getLocale: () => 'en',
    chapterLabel: (chapter) => chapter,
    onOpen: (result) => opened.push(result.slug),
  });
  const input = els.searchInput;
  const type = (value) => {
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const press = (key) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const titles = () => [...els.results.querySelectorAll('.manual-result__title')].map((node) => node.textContent);
  const chosen = () => document.getElementById(input.getAttribute('aria-activedescendant'))
    ?.querySelector('.manual-result__title').textContent ?? null;
  return { dom, els, opened, type, press, titles, chosen };
}

test('↓ right after typing chooses among the results for the whole query (#854)', async () => {
  const { dom, opened, type, press, titles, chosen } = await setup();
  try {
    type('san');
    await wait(150);
    assert.ok(titles().includes('Sanity'), 'the first letters are on screen');

    type('sandbox');
    press('ArrowDown');
    await wait(20);
    assert.deepEqual(titles(), ['Sandbox', 'Modes'], 'the search for the whole word ran first');
    assert.equal(chosen(), 'Modes', '↓ moved from the best hit of "sandbox" to the next');

    await wait(150);
    assert.equal(chosen(), 'Modes', 'the delayed search does not redraw the choice away');
    press('Enter');
    assert.deepEqual(opened, ['modes']);
  } finally {
    dom.cleanup();
  }
});

test('Enter right after typing opens the best hit of the whole query', async () => {
  const { dom, opened, type, press } = await setup();
  try {
    type('san');
    await wait(150);
    type('modes');
    press('Enter');
    await wait(20);
    assert.deepEqual(opened, ['modes']);
  } finally {
    dom.cleanup();
  }
});

test('the list is busy from a keystroke until its results are drawn', async () => {
  const { dom, els, type } = await setup();
  try {
    type('sandbox');
    assert.equal(els.results.getAttribute('aria-busy'), 'true');
    await wait(150);
    assert.equal(els.results.hasAttribute('aria-busy'), false);

    type('');
    assert.equal(els.results.getAttribute('aria-busy'), 'true');
    await wait(150);
    assert.equal(els.results.hasAttribute('aria-busy'), false, 'an emptied field settles too');
    assert.equal(els.nav.hidden, false, 'and brings the chapters back');
  } finally {
    dom.cleanup();
  }
});
