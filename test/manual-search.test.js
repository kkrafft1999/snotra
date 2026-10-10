// Full-text search in the help window (#847): folding, ranking, excerpts and
// sections — against the real bundled manual, so that a page rewritten in
// manual/ is searched the way the window will search it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { marked } = require('marked');
const { bundleManual } = require('../scripts/bundle-manual.js');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

let dom = null;
let search = null;
let headingSlug = null;
let targetDir = null;
let bundle = null;
const indexes = {};

function pagesOf(locale) {
  return Object.entries(bundle.index.locales[locale].pages).map(([slug, meta]) => ({
    slug,
    ...meta,
    markdown: fs.readFileSync(path.join(targetDir, 'pages', locale, `${slug}.md`), 'utf8'),
  }));
}

test.before(async () => {
  dom = setupRendererDom();
  search = await importRenderer('manual', 'manual-search.js');
  ({ headingSlug } = await importRenderer('file-views', 'markdown-document.js'));
  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-manual-search-'));
  bundle = bundleManual({ manualDir: path.join(__dirname, '..', 'manual'), targetDir });
  for (const locale of ['en', 'de']) {
    indexes[locale] = search.buildSearchIndex(pagesOf(locale), { lexer: marked.lexer, slugify: headingSlug });
  }
});

test.after(() => {
  dom?.cleanup();
  fs.rmSync(targetDir, { recursive: true, force: true });
});

const excerptText = (result) => result.excerpt.map((part) => part.text).join('');
const marked_ = (result) => result.excerpt.filter((part) => part.match).map((part) => part.text);

test('fold ignores case and accents and keeps the way back to the original', () => {
  const { text, map } = search.fold('Schlüssel ẞtraße');
  assert.equal(text, 'schlussel sstrasse');
  // "ss" from "ß" points twice at the same original character.
  assert.equal(map[text.lastIndexOf('sse')], 'Schlüssel ẞtraße'.indexOf('ß'));
  assert.equal(map.length, text.length);
});

test('a query needs two characters and becomes its distinct words', () => {
  assert.deepEqual(search.queryTerms('a'), []);
  assert.deepEqual(search.queryTerms('  '), []);
  assert.deepEqual(search.queryTerms('Default  MODE default'), ['default', 'mode']);
});

test('a page whose title holds the word comes first', () => {
  const [first] = search.searchManual(indexes.en, 'sandbox');
  assert.equal(first.slug, 'safety/sandbox');
});

test('every word has to be on the page, and the best section is named', () => {
  const results = search.searchManual(indexes.en, 'default mode');
  assert.equal(results[0].slug, 'safety/choose-a-mode');
  assert.equal(results[0].heading, 'Give a folder a default mode');
  assert.equal(results[0].anchor, 'give-a-folder-a-default-mode');
  for (const result of results) {
    const page = indexes.en.find((entry) => entry.slug === result.slug);
    const all = [page.folded.title, page.folded.description, ...page.sections.flatMap((s) => [s.folded.heading, s.folded.text.text])].join(' ');
    assert.ok(all.includes('default') && all.includes('mode'), `${result.slug} lacks a word`);
  }
});

test('a whole word ranks above the start of a longer one', () => {
  const results = search.searchManual(indexes.en, 'default mode');
  const glossary = results.findIndex((r) => r.slug === 'reference/glossary');
  const models = results.findIndex((r) => r.slug === 'customising/models');
  assert.ok(glossary !== -1 && glossary < models, `glossary at ${glossary}, models at ${models}`);
});

test('accents do not matter, and inside a compound a word of four letters is found', () => {
  const plain = search.searchManual(indexes.de, 'schlussel');
  const accented = search.searchManual(indexes.de, 'Schlüssel');
  assert.ok(plain.length > 0);
  assert.deepEqual(plain.map((r) => r.slug), accented.map((r) => r.slug));
  // "modus" inside "Standardmodus".
  const compound = search.searchManual(indexes.de, 'modus');
  assert.ok(compound.some((r) => /Standardmodus/.test(excerptText(r))), 'Standardmodus not found by "modus"');
  // Short words count only at the start of a word: "ai" finds Snotra AI, not every "Detail".
  for (const result of search.searchManual(indexes.de, 'ai')) {
    for (const hit of marked_(result)) assert.match(hit, /^ai$/i);
  }
});

test('the excerpt marks the words and stays short', () => {
  const [first] = search.searchManual(indexes.en, 'keychain');
  assert.ok(first.excerpt.length > 0);
  assert.ok(marked_(first).length > 0);
  for (const hit of marked_(first)) assert.equal(search.fold(hit).text, 'keychain');
  assert.ok(excerptText(first).length < 200, excerptText(first));
  assert.ok(!/\[since/i.test(excerptText(first)), 'since markers are not text');
});

test('nothing found is an empty list, not an error', () => {
  assert.deepEqual(search.searchManual(indexes.en, 'xyzzy plugh'), []);
  assert.deepEqual(search.searchManual(indexes.en, 'x'), []);
});

test('the anchors of the index are the ones the help window gives its headings', () => {
  // Same rule as manual-bundle.test.js: rendered heading text through headingSlug.
  for (const locale of ['en', 'de']) {
    for (const page of indexes[locale]) {
      const markdown = fs.readFileSync(path.join(targetDir, 'pages', locale, `${page.slug}.md`), 'utf8');
      const seen = new Map();
      const expected = [];
      for (const token of marked.lexer(markdown)) {
        if (token.type !== 'heading') continue;
        const text = marked.parseInline(token.text).replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const base = headingSlug(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        expected.push(count === 0 ? base : `${base}-${count}`);
      }
      const actual = page.sections.map((section) => section.anchor).filter(Boolean);
      assert.deepEqual(actual, expected, `${locale}/${page.slug}`);
    }
  }
});
