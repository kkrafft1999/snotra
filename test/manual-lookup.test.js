'use strict';

// The model's look into the bundled manual (#947): search_manual and
// read_manual_page, against the real manual and against a small fake one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundleManual } = require('../scripts/bundle-manual.js');
const { createManualService } = require('../src/main/services/manual-service');
const {
  createManualLookup,
  loadVendoredMarkedLexer,
  parsePageReference,
  MAX_PAGE_CHARS,
} = require('../src/main/services/manual-lookup');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { summarizeToolCall } = require('../src/shared/presentation/tool-display');
const { toolCategory, TOOL_CATEGORIES } = require('../src/shared/contracts/tool-categories');
const { toolConfigGroup, CONFIG_TOOL_GROUPS } = require('../src/shared/contracts/chat-configuration');
const { removeTempDirSync } = require('./helpers/temp-dir');

const VENDORED_MARKED = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'marked.umd.js');
const loadLexer = () => loadVendoredMarkedLexer(VENDORED_MARKED, { readFileSync: fs.readFileSync });

let targetDir = null;
let lookup = null;
let lexerLoads = 0;

test.before(() => {
  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-manual-lookup-'));
  bundleManual({ manualDir: path.join(__dirname, '..', 'manual'), targetDir });
  const manual = createManualService({ fs, path, bundleDir: targetDir });
  lookup = createManualLookup({
    manual,
    loadLexer: () => {
      lexerLoads += 1;
      return loadLexer();
    },
  });
});

test.after(() => {
  removeTempDirSync(targetDir);
});

/** A manual service over pages given inline, for the edge cases. */
function fakeManual(pages) {
  const index = { locales: {} };
  for (const locale of ['en', 'de']) {
    index.locales[locale] = {
      nav: [],
      pages: Object.fromEntries(Object.entries(pages).map(([slug, page]) => [slug, { title: page.title, description: '' }])),
    };
  }
  return {
    isAvailable: () => true,
    getIndex: (locale) => ({ locale, ...index.locales[locale] }),
    getPage: (locale, slug) => ({ slug, title: pages[slug].title, description: '', markdown: pages[slug].markdown }),
    getAllPages: (locale) => Object.keys(pages).map((slug) => ({ slug, title: pages[slug].title, description: '', markdown: pages[slug].markdown })),
  };
}

test('the vendored marked yields a lexer without a DOM or a global', () => {
  const lexer = loadLexer();
  assert.equal(typeof lexer, 'function');
  assert.equal(lexer('# Title')[0].type, 'heading');
  assert.equal(globalThis.marked, undefined);
});

test('search names page, section, excerpt and the address on the web manual', () => {
  const { locale, results } = lookup.search({ query: 'sandbox', locale: 'en' });
  assert.equal(locale, 'en');
  assert.ok(results.length > 0 && results.length <= 5);
  const hit = results[0];
  assert.match(hit.slug, /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/);
  assert.equal(typeof hit.title, 'string');
  assert.equal(typeof hit.excerpt, 'string');
  assert.ok(hit.excerpt.length > 0);
  assert.ok(hit.url.startsWith(`https://docs.snotra-ai.dev/${hit.slug}/`), hit.url);
  if (hit.anchor) assert.ok(hit.url.endsWith(`#${encodeURIComponent(hit.anchor)}`));
});

test('search follows the language and ignores case and accents', () => {
  const { results } = lookup.search({ query: 'freigabe', locale: 'de' });
  assert.ok(results.length > 0);
  assert.ok(results.every((hit) => hit.url.startsWith('https://docs.snotra-ai.dev/de/')));
  // An unknown language falls back to English rather than failing.
  assert.equal(lookup.search({ query: 'sandbox', locale: 'fr' }).locale, 'en');
});

test('search keeps the limit between one and ten', () => {
  assert.equal(lookup.search({ query: 'the', locale: 'en', limit: 1 }).results.length, 1);
  assert.ok(lookup.search({ query: 'the', locale: 'en', limit: 50 }).results.length <= 10);
  assert.ok(lookup.search({ query: 'the', locale: 'en', limit: 0 }).results.length >= 1);
});

test('a query that is too short or finds nothing says so', () => {
  assert.match(lookup.search({ query: ' a ', locale: 'en' }).error, /at least 2 characters/);
  assert.match(lookup.search({ locale: 'en' }).error, /at least 2 characters/);
  const none = lookup.search({ query: 'qwzxv', locale: 'en' });
  assert.deepEqual(none.results, []);
  assert.match(none.hint, /fewer or other words/);
});

test('a page comes back with web links and screenshot descriptions', () => {
  const page = lookup.read({ slug: 'index', locale: 'en' });
  assert.equal(page.slug, 'index');
  assert.equal(page.url, 'https://docs.snotra-ai.dev/');
  assert.equal(typeof page.title, 'string');
  assert.doesNotMatch(page.markdown, /!\[/);
  assert.doesNotMatch(page.markdown, /screenshots\//);
  assert.match(page.markdown, /\*\(Screenshot: [^)]+/);
  // Every link between pages is an address the user can open.
  const targets = [...page.markdown.matchAll(/\]\(([^)\s]+)/g)].map((match) => match[1]);
  assert.ok(targets.length > 0);
  for (const target of targets) assert.match(target, /^(?:https?:|mailto:)/, target);
});

test('a section is the heading with everything below it, up to the next of its level', () => {
  const [hit] = lookup.search({ query: 'sandbox', locale: 'en' }).results.filter((entry) => entry.anchor);
  assert.ok(hit, 'a hit inside a section');
  const whole = lookup.read({ slug: hit.slug, locale: 'en' });
  const section = lookup.read({ slug: hit.slug, anchor: hit.anchor, locale: 'en' });
  assert.equal(section.section, hit.section);
  assert.equal(section.anchor, hit.anchor);
  assert.equal(section.url, hit.url);
  assert.match(section.markdown, /^#{2,6} /);
  assert.ok(section.markdown.length < whole.markdown.length || whole.truncated);

  const fake = createManualLookup({
    manual: fakeManual({
      page: {
        title: 'Page',
        markdown: 'Intro.\n\n## One\n\nFirst.\n\n### One A\n\nNested.\n\n## Two\n\nSecond.\n\n## One\n\nRepeated.\n',
      },
    }),
    loadLexer,
  });
  const one = fake.read({ slug: 'page', anchor: 'one' });
  assert.match(one.markdown, /First\./);
  assert.match(one.markdown, /Nested\./);
  assert.doesNotMatch(one.markdown, /Second\.|Repeated\./);
  // A repeated heading gets the help window's counted-up anchor.
  assert.match(fake.read({ slug: 'page', anchor: 'one-1' }).markdown, /Repeated\./);
  assert.match(fake.read({ slug: 'page', anchor: '#two' }).markdown, /^## Two\n\nSecond\.$/);
});

test('the page may be named by its web address, with language and section in it', () => {
  assert.deepEqual(
    parsePageReference('https://docs.snotra-ai.dev/de/safety/sandbox/#was-du-brauchst'),
    { slug: 'safety/sandbox', anchor: 'was-du-brauchst', locale: 'de' },
  );
  assert.deepEqual(parsePageReference('/safety/sandbox/'), { slug: 'safety/sandbox', anchor: null, locale: null });
  assert.deepEqual(parsePageReference('safety/sandbox.md'), { slug: 'safety/sandbox', anchor: null, locale: null });
  assert.deepEqual(parsePageReference('https://docs.snotra-ai.dev/'), { slug: 'index', anchor: null, locale: null });
  assert.deepEqual(parsePageReference('de'), { slug: 'index', anchor: null, locale: 'de' });
  assert.equal(parsePageReference('design/colours').slug, 'design/colours');

  const page = lookup.read({ slug: 'https://docs.snotra-ai.dev/de/safety/sandbox/' });
  assert.equal(page.locale, 'de');
  assert.equal(page.slug, 'safety/sandbox');
  // A language given explicitly wins over the address.
  assert.equal(lookup.read({ slug: 'https://docs.snotra-ai.dev/de/safety/sandbox/', locale: 'en' }).locale, 'en');
});

test('an unknown page or section answers with what there is', () => {
  const page = lookup.read({ slug: 'no/such-page', locale: 'en' });
  assert.match(page.error, /no manual page "no\/such-page"/);
  assert.ok(page.slugs.includes('safety/sandbox'));
  const section = lookup.read({ slug: 'safety/sandbox', anchor: 'no-such-section', locale: 'en' });
  assert.match(section.error, /no section "no-such-section"/);
  assert.ok(section.sections.length > 0);
  assert.ok(section.sections.every((entry) => entry.heading && entry.anchor));
});

test('a long page is cut at a line and lists its sections', () => {
  const paragraph = `${'word '.repeat(40).trim()}\n\n`;
  const fake = createManualLookup({
    manual: fakeManual({
      long: { title: 'Long', markdown: `Intro.\n\n## Start\n\n${paragraph.repeat(200)}## End\n\nLast.\n` },
      short: { title: 'Short', markdown: 'Short.\n' },
    }),
    loadLexer,
  });
  const long = fake.read({ slug: 'long' });
  assert.equal(long.truncated, true);
  assert.ok(long.markdown.length <= MAX_PAGE_CHARS + 3);
  assert.ok(long.markdown.endsWith('\n\n…'));
  assert.deepEqual(long.sections, [{ heading: 'Start', anchor: 'start' }, { heading: 'End', anchor: 'end' }]);
  const end = fake.read({ slug: 'long', anchor: 'end' });
  assert.equal(end.truncated, undefined);
  assert.equal(end.markdown, '## End\n\nLast.');
  const short = fake.read({ slug: 'short' });
  assert.equal(short.truncated, undefined);
  assert.equal(short.sections, undefined);
});

test('the lexer is loaded once, on the first look', () => {
  const before = lexerLoads;
  lookup.search({ query: 'mode', locale: 'en' });
  lookup.read({ slug: 'index', locale: 'de' });
  assert.ok(lexerLoads - before <= 1);
  assert.ok(lexerLoads <= 1);
});

// ── As tools ────────────────────────────────────────────────────────────────

function makeFsServiceStub() {
  return { listDirectoryTool() {}, readFileTextTool() {} };
}

test('both tools read, need no folder and are offered only with a manual', async () => {
  const without = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const offered = (registry) => registry.getTools().map((tool) => tool.function.name);
  assert.equal(offered(without).includes('search_manual'), false);
  assert.equal(offered(without).includes('read_manual_page'), false);

  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub(), manual: lookup });
  const names = offered(registry);
  assert.ok(names.includes('search_manual'));
  assert.ok(names.includes('read_manual_page'));
  for (const name of ['search_manual', 'read_manual_page']) {
    const definition = registry.getDefinition(name);
    assert.equal(definition.riskClass, 'read', name);
    assert.equal(definition.requiresWorkspace, false, name);
    assert.deepEqual(definition.targets({}), [], name);
  }
});

test('the tools answer in the language of the app unless asked for the other one', async () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub(), manual: lookup });
  const context = { approved: true, locale: 'de' };
  const search = JSON.parse(await registry.execute('search_manual', { query: 'sandbox' }, context));
  assert.equal(search.locale, 'de');
  const english = JSON.parse(await registry.execute('search_manual', { query: 'sandbox', locale: 'en' }, context));
  assert.equal(english.locale, 'en');
  const page = JSON.parse(await registry.execute('read_manual_page', { slug: search.results[0].slug }, context));
  assert.equal(page.locale, 'de');
  assert.equal(typeof page.markdown, 'string');
  const missing = JSON.parse(await registry.execute('read_manual_page', { slug: 'nope' }, context));
  assert.match(missing.error, /no manual page/);
});

test('a lookup that throws comes back as an error, not as a crash', async () => {
  const broken = { isAvailable: () => true, search: () => { throw new Error('boom'); }, read: () => { throw new Error('bang'); } };
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub(), manual: broken });
  assert.deepEqual(JSON.parse(await registry.execute('search_manual', { query: 'x y' }, { approved: true })), { error: 'boom' });
  assert.deepEqual(JSON.parse(await registry.execute('read_manual_page', { slug: 'x' }, { approved: true })), { error: 'bang' });
});

test('the log names a look into the manual as such, in both languages', () => {
  assert.equal(toolCategory('search_manual'), TOOL_CATEGORIES.MANUAL);
  assert.equal(toolCategory('read_manual_page'), TOOL_CATEGORIES.MANUAL);
  assert.equal(toolConfigGroup('search_manual'), CONFIG_TOOL_GROUPS.READ);
  assert.equal(toolConfigGroup('read_manual_page'), CONFIG_TOOL_GROUPS.READ);

  assert.equal(summarizeToolCall('search_manual', { query: 'network' }, 'start', 'en'), 'Searching the manual for “network” …');
  assert.equal(summarizeToolCall('search_manual', { query: 'Netzwerk' }, 'done', 'de'), 'Im Handbuch nach „Netzwerk“ gesucht');
  assert.equal(summarizeToolCall('search_manual', {}, 'done', 'en'), 'Searched the manual');
  assert.equal(
    summarizeToolCall('read_manual_page', { slug: 'safety/sandbox', anchor: '#what-you-need' }, 'done', 'en'),
    'Manual page safety/sandbox#what-you-need read',
  );
  assert.equal(summarizeToolCall('read_manual_page', { slug: 'safety/sandbox' }, 'start', 'de'), 'Handbuchseite safety/sandbox wird gelesen …');
  assert.equal(summarizeToolCall('read_manual_page', {}, 'start', 'de'), 'Eine Handbuchseite wird gelesen …');
});
