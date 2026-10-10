// The user manual that ships with the app (#790): what scripts/bundle-manual.js
// puts into src/manual/, and whether the help window can follow every link of
// it. The pages are written for the web manual, so a link the web resolves but
// the help window does not would only show up as a dead click — these tests
// catch it when the page is written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { marked } = require('marked');
const { bundleManual, parsePage, LOCALES } = require('../scripts/bundle-manual.js');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const MANUAL_DIR = path.join(__dirname, '..', 'manual');
const DOCS_DIR = path.join(MANUAL_DIR, 'src', 'content', 'docs');

let targetDir = null;
let bundle = null;
let links = null;
let headingSlug = null;
let dom = null;

test.before(async () => {
  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-manual-'));
  bundle = bundleManual({ manualDir: MANUAL_DIR, targetDir });
  dom = setupRendererDom();
  links = await importRenderer('manual', 'manual-links.js');
  ({ headingSlug } = await importRenderer('file-views', 'markdown-document.js'));
});

test.after(() => {
  dom?.cleanup();
  fs.rmSync(targetDir, { recursive: true, force: true });
});

function readBundledPage(locale, slug) {
  return fs.readFileSync(path.join(targetDir, 'pages', locale, `${slug}.md`), 'utf8');
}

/** The anchors of a page, the way the help window sets them (`data-md-anchor`). */
function anchorsOf(markdown) {
  const seen = new Map();
  const anchors = new Set();
  for (const token of marked.lexer(markdown)) {
    if (token.type !== 'heading') continue;
    const text = marked.parseInline(token.text).replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const base = headingSlug(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

/** Every link of a page — not the images, which the screenshot test covers. */
function linksOf(markdown) {
  const found = [];
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type === 'link') found.push(token.href);
  });
  return found;
}

test('every page of both languages is bundled with its title and description', () => {
  for (const locale of LOCALES) {
    const { pages } = bundle.index.locales[locale];
    assert.ok(Object.keys(pages).length >= 40, `${locale}: ${Object.keys(pages).length} pages`);
    for (const [slug, meta] of Object.entries(pages)) {
      assert.ok(meta.title, `${locale}/${slug} has no title`);
      assert.ok(meta.description, `${locale}/${slug} has no description`);
      const body = readBundledPage(locale, slug);
      assert.ok(!body.startsWith('---'), `${locale}/${slug}: the front matter must not reach the page`);
    }
  }
  assert.deepEqual(
    Object.keys(bundle.index.locales.de.pages).sort(),
    Object.keys(bundle.index.locales.en.pages).sort(),
    'English and German have the same pages',
  );
});

test('the front matter of the pages uses only what the bundler reads', () => {
  // bundle-manual.js reads title, description and sidebar.order and nothing
  // else. A new key — a hero, a template, a sidebar label — would be lost in
  // the app without a word; this is where it is noticed.
  const allowed = new Set(['title', 'description', 'sidebar', 'sidebar.order']);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.md') ? [path.join(dir, entry.name)] : []
  ));
  for (const file of walk(DOCS_DIR)) {
    const head = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    let section = null;
    for (const line of head.split('\n')) {
      const top = line.match(/^([A-Za-z]+):/);
      const nested = line.match(/^\s+([A-Za-z]+):/);
      if (top) section = top[1];
      const key = top ? top[1] : nested ? `${section}.${nested[1]}` : null;
      if (key) assert.ok(allowed.has(key), `${path.relative(DOCS_DIR, file)}: front matter key "${key}"`);
    }
  }
});

test('parsePage reads title, description and order, and drops the head', () => {
  const page = parsePage('---\ntitle: Choose a mode\ndescription: "Switch it."\nsidebar:\n  order: 3\n---\n\nBody\n');
  assert.deepEqual(page, { title: 'Choose a mode', description: 'Switch it.', order: 3, body: 'Body\n' });
  assert.equal(parsePage('No head').body, 'No head');
});

test('the chapters follow chapters.json, the pages their sidebar order', () => {
  const chapters = JSON.parse(fs.readFileSync(path.join(MANUAL_DIR, 'chapters.json'), 'utf8'));
  for (const locale of LOCALES) {
    const { nav, pages } = bundle.index.locales[locale];
    assert.equal(nav[0].slug, 'index');
    assert.equal(nav[0].label, chapters.overview.label[locale]);
    assert.deepEqual(nav.slice(1).map((item) => item.chapter), chapters.chapters.map((c) => c.directory));
    // Every page is reachable from the chapter list.
    const listed = new Set(['index', ...nav.slice(1).flatMap((item) => item.pages)]);
    assert.deepEqual([...listed].sort(), Object.keys(pages).sort(), `${locale}: pages missing from the chapters`);
  }
  const safety = bundle.index.locales.en.nav.find((item) => item.chapter === 'safety');
  assert.equal(safety.pages.indexOf('safety/choose-a-mode') > safety.pages.indexOf('safety/why-snotra-asks'), true);
});

test('every screenshot of a page has both theme variants in its language', () => {
  for (const locale of LOCALES) {
    for (const slug of Object.keys(bundle.index.locales[locale].pages)) {
      marked.walkTokens(marked.lexer(readBundledPage(locale, slug)), (token) => {
        if (token.type !== 'image') return;
        const motif = links.screenshotMotif(token.href);
        assert.ok(motif, `${locale}/${slug}: image "${token.href}" is not a screenshot of the manual`);
        for (const theme of ['light', 'dark']) {
          assert.ok(fs.existsSync(path.join(targetDir, 'screenshots', `${motif}.${locale}.${theme}.webp`)),
            `${locale}/${slug}: ${motif}.${locale}.${theme}.webp`);
        }
      });
    }
  }
});

test('every link between pages and every #section resolves in the help window', () => {
  const problems = [];
  for (const locale of LOCALES) {
    const { pages } = bundle.index.locales[locale];
    const anchors = new Map(Object.keys(pages).map((slug) => [slug, anchorsOf(readBundledPage(locale, slug))]));
    for (const slug of Object.keys(pages)) {
      for (const href of linksOf(readBundledPage(locale, slug))) {
        if (/^(?:https?:|mailto:)/i.test(href)) continue;
        const hashAt = href.indexOf('#');
        const target = hashAt === -1 ? href : href.slice(0, hashAt);
        const fragment = hashAt === -1 ? '' : decodeURIComponent(href.slice(hashAt + 1));
        const page = target ? links.resolveManualLink(target, slug, pages) : slug;
        if (!page) {
          problems.push(`${locale}/${slug}: "${href}" names no page`);
        } else if (fragment && !anchors.get(page).has(fragment)) {
          problems.push(`${locale}/${slug}: "${href}" — no heading #${fragment} on ${page}`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('resolveManualLink turns web addresses into slugs, in both languages', () => {
  const pages = { index: {}, 'safety/sandbox': {}, 'safety/choose-a-mode': {}, 'chatting/chat-history': {} };
  const { resolveManualLink, pagePathOf } = links;
  assert.equal(pagePathOf('index'), '/');
  assert.equal(pagePathOf('safety/sandbox'), '/safety/sandbox/');
  assert.equal(resolveManualLink('../sandbox/', 'safety/choose-a-mode', pages), 'safety/sandbox');
  assert.equal(resolveManualLink('../../chatting/chat-history/', 'safety/sandbox', pages), 'chatting/chat-history');
  assert.equal(resolveManualLink('chatting/chat-history/', 'index', pages), 'chatting/chat-history');
  assert.equal(resolveManualLink('/de/safety/sandbox/', 'index', pages), 'safety/sandbox');
  assert.equal(resolveManualLink('../../', 'safety/sandbox', pages), 'index');
  assert.equal(resolveManualLink('../sandbox.md', 'safety/choose-a-mode', pages), 'safety/sandbox');
  assert.equal(resolveManualLink('../missing/', 'safety/sandbox', pages), null);
  assert.equal(resolveManualLink('//evil.example/x', 'index', pages), null);
  assert.equal(resolveManualLink('../../../../../etc/passwd', 'safety/sandbox', pages), null);
});

test('screenshots and since markers are recognised the way the web reads them', () => {
  assert.equal(links.screenshotMotif('screenshots/mode-menu.webp'), 'mode-menu');
  assert.equal(links.screenshotMotif('./screenshots/overview.webp'), 'overview');
  assert.equal(links.screenshotMotif('screenshots/../secret.webp'), null);
  assert.equal(links.screenshotMotif('https://example.com/a.webp'), null);
  const versions = [...'[since 1.17] and [seit 1.18.2]'.matchAll(links.SINCE_MARKER)].map((m) => m[1]);
  assert.deepEqual(versions, ['1.17', '1.18.2']);
});
