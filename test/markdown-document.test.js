// The parts of the Markdown viewer that need no mounted view (#344): the front
// matter, the paths a document points to, and the inert tree the view puts on
// screen.
//
// `marked` is the real one from the vendor folder, DOMPurify a stand-in that
// passes everything through: sanitizing is wrong under happy-dom (see
// test/helpers/dom.js) and is checked in the running app by
// `e2e/smoke.test.mjs`. Without the real hook, a relative link keeps its
// `href` here instead of moving to `data-workspace-href` — `classifyLink`
// reads both, and both are tested.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom } = require('./helpers/dom.js');

let dom = null;
let doc = null;

test.before(async () => {
  dom = setupRendererDom();
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };
  doc = await importRenderer('file-views', 'markdown-document.js');
});

test.after(() => {
  delete globalThis.DOMPurify;
  dom?.cleanup();
});

// ── Front matter ────────────────────────────────────────────────────────────

test('a document without a head is all body', () => {
  const text = '# Title\n\nText.\n';
  assert.deepEqual(doc.splitDocument(text), { frontMatter: null, body: text });
  // A rule in the middle is no head.
  assert.equal(doc.splitDocument('Text\n\n---\n\nMore').frontMatter, null);
});

test('the head of a SKILL.md becomes key/value entries, folded scalars included', () => {
  const { frontMatter, body } = doc.splitDocument([
    '---',
    'name: release',
    'description: >',
    '  Publishes a new release,',
    '  then tags it.',
    'tags: [release, git]',
    'license: "MIT"',
    '---',
    '# Release',
  ].join('\n'));
  assert.deepEqual(frontMatter.entries, [
    { key: 'name', value: 'release' },
    { key: 'description', value: 'Publishes a new release, then tags it.' },
    { key: 'tags', value: 'release, git' },
    { key: 'license', value: 'MIT' },
  ]);
  assert.equal(body, '# Release');
});

test('a nested map is shown as written, not flattened into its parent', () => {
  const { frontMatter } = doc.splitDocument([
    '---',
    'name: x',
    'metadata:',
    '  owner: kkrafft1999',
    '  since: "1.4.0"',
    'aliases:',
    '  - one',
    '  - two',
    '---',
  ].join('\n'));
  assert.deepEqual(frontMatter.entries, [
    { key: 'name', value: 'x' },
    { key: 'metadata', nested: 'owner: kkrafft1999\nsince: "1.4.0"' },
    { key: 'aliases', value: 'one, two' },
  ]);
});

test('a literal block keeps its lines even when one of them looks like a key', () => {
  const { frontMatter } = doc.splitDocument('---\nnote: |\n  first line\n  Note: second\n---\n');
  assert.deepEqual(frontMatter.entries, [{ key: 'note', value: 'first line\nNote: second' }]);
});

test('a head that is no key/value list falls back to the raw lines', () => {
  const { frontMatter } = doc.splitDocument('---\n- just\n- a list\n---\nBody');
  assert.deepEqual(frontMatter, { raw: '- just\n- a list' });
  assert.equal(doc.splitDocument('---\n---\nBody').frontMatter, null);
});

// ── Paths ───────────────────────────────────────────────────────────────────

test('relative paths start at the folder of the file, a leading slash at the workspace', () => {
  const where = { fileDir: '/ws/docs/guide', workspaceRoot: '/ws' };
  assert.equal(doc.resolveDocumentPath('img/a.png', where), '/ws/docs/guide/img/a.png');
  assert.equal(doc.resolveDocumentPath('../../README.md', where), '/ws/README.md');
  assert.equal(doc.resolveDocumentPath('/CONTRIBUTING.md', where), '/ws/CONTRIBUTING.md');
  assert.equal(doc.resolveDocumentPath('My%20Notes.md#top', where), '/ws/docs/guide/My Notes.md');
  assert.equal(doc.resolveDocumentPath('a.png?raw=true', where), '/ws/docs/guide/a.png');
  assert.equal(doc.resolveDocumentPath('/x.md', { fileDir: '/ws', workspaceRoot: null }), null);
  assert.equal(doc.resolveDocumentPath('#only-a-fragment', where), null);
});

test('Windows: relative paths keep the backslash, a drive path stays as it is', () => {
  const where = { fileDir: 'C:\\ws\\docs', workspaceRoot: 'C:\\ws' };
  assert.equal(doc.resolveDocumentPath('../img/a.png', where), 'C:\\ws\\img\\a.png');
  assert.equal(doc.resolveDocumentPath('/README.md', where), 'C:\\ws\\README.md');
  assert.equal(doc.resolveDocumentPath('D:\\pics\\a.png', where), 'D:\\pics\\a.png');
});

test('heading slugs follow GitHub', () => {
  assert.equal(doc.headingSlug('Steps'), 'steps');
  assert.equal(doc.headingSlug('  Getting Started!  '), 'getting-started');
  assert.equal(doc.headingSlug('Über die App — kurz'), 'über-die-app--kurz');
  assert.equal(doc.headingSlug('v1.2 `code`'), 'v12-code');
});

// ── Links ───────────────────────────────────────────────────────────────────

const anchor = (attrs) => {
  const a = document.createElement('a');
  for (const [name, value] of Object.entries(attrs)) a.setAttribute(name, value);
  return a;
};

test('links are external, an anchor, a file of the workspace — or nothing', () => {
  assert.deepEqual(doc.classifyLink(anchor({ href: 'https://example.com/a' })), { kind: 'external', href: 'https://example.com/a' });
  assert.deepEqual(doc.classifyLink(anchor({ href: 'mailto:a@b.c' })), { kind: 'external', href: 'mailto:a@b.c' });
  assert.deepEqual(doc.classifyLink(anchor({ href: '#Getting%20started' })), { kind: 'anchor', slug: 'Getting started' });
  assert.deepEqual(doc.classifyLink(anchor({ href: '../README.md#setup' })), { kind: 'file', target: '../README.md', fragment: 'setup' });
  // What the real sanitizer hands over for a relative link.
  assert.deepEqual(doc.classifyLink(anchor({ 'data-workspace-href': 'docs/a.md' })), { kind: 'file', target: 'docs/a.md', fragment: '' });
  for (const href of ['javascript:alert(1)', 'tel:+49', 'file:///etc/passwd', '//evil.example/x', '']) {
    assert.equal(doc.classifyLink(anchor({ href })), null, href);
  }
  assert.equal(doc.classifyLink(anchor({})), null);
});

// ── The tree ────────────────────────────────────────────────────────────────

test('no <img> leaves the template with a src — the view loads each one itself', () => {
  const root = doc.renderMarkdownFragment('![Flow](img/flow.png)\n\nText ![badge](https://x.test/b.svg) inline.\n');
  const images = [...root.querySelectorAll('img')];
  assert.equal(images.length, 2);
  for (const img of images) assert.equal(img.hasAttribute('src'), false);
  assert.deepEqual(images.map((img) => img.getAttribute('data-md-src')), ['img/flow.png', 'https://x.test/b.svg']);
  // Alone in its paragraph: a figure. Inside a sentence: stays in the line.
  assert.equal(images[0].closest('p').classList.contains('md-figure'), true);
  assert.equal(images[1].closest('p').classList.contains('md-figure'), false);
});

test('a hard-wrapped paragraph reads as one, as on GitHub', () => {
  const root = doc.renderMarkdownFragment('one line\nthe next line\n');
  assert.equal(root.querySelectorAll('br').length, 0);
  assert.equal(root.querySelector('p').textContent, 'one line\nthe next line');
});

test('headings get anchors without ids, duplicates numbered; tables get a scrolling frame', () => {
  const root = doc.renderMarkdownFragment('# Chat input\n\n## Steps\n\n## Steps\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  const headings = [...root.querySelectorAll('h1, h2')];
  assert.deepEqual(headings.map((h) => h.getAttribute('data-md-anchor')), ['chat-input', 'steps', 'steps-1']);
  assert.ok(headings.every((h) => !h.id), 'no id that could collide with the window');
  const table = root.querySelector('table');
  assert.equal(table.parentElement.className, 'md-table-frame');
});
