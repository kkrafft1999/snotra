/**
 * Questions about Snotra itself are answered from the user manual (#952). The
 * system skill `snotra-capabilities` only says where to look and how: call
 * `get_configuration` for what this chat has, search the manual with keywords,
 * read `reference/capabilities` for the overview. The facts live in the manual.
 *
 * The drift guard of #114 moves with them: a tool the registry offers and the
 * manual does not name used to make the app deny what it can do. It is now
 * checked against the manual page of the built-in tools, in both languages.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { marked } = require('marked');

const { createWorkspaceToolRegistry } = require('../src/application/tools/workspace-tool-registry');
const { bundleManual } = require('../scripts/bundle-manual.js');
const search = require('../src/shared/manual/manual-search.js');
const { headingSlug } = require('../src/shared/runtime/heading-slug.js');
const { translateMessage } = require('../src/shared/i18n');
const { removeTempDirSync } = require('./helpers/temp-dir');

const ROOT = path.join(__dirname, '..');
const SKILL_PATH = path.join(ROOT, 'system-skills', 'snotra-capabilities', 'SKILL.md');
const DOCS = path.join(ROOT, 'manual', 'src', 'content', 'docs');
const LOCALES = ['en', 'de'];
const OVERVIEW_PAGE = 'reference/capabilities';

const skillText = fs.readFileSync(SKILL_PATH, 'utf8');
const pageSource = (locale, slug) =>
  fs.readFileSync(path.join(DOCS, locale === 'en' ? '' : locale, `${slug}.md`), 'utf8');

// The catalog never calls a handler, an empty fsService is enough.
const registry = createWorkspaceToolRegistry({ fsService: {} });
// Two sources, because neither alone is what the model sees: `listCatalog()`
// leaves out the basic equipment (#195), `getTools()` the tools that only
// appear once configured (keys, Python, shell). The union is what counts.
const catalog = [
  ...registry.listCatalog(),
  ...registry
    .getTools()
    .map((tool) => tool.function.name)
    .filter((name) => !registry.listCatalog().some((entry) => entry.name === name))
    .map((name) => ({ name, riskClass: registry.getDefinition(name).riskClass })),
];

let bundleDir = null;
const indexes = {};

test.before(() => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-capabilities-'));
  const bundle = bundleManual({ manualDir: path.join(ROOT, 'manual'), targetDir: bundleDir });
  for (const locale of LOCALES) {
    const pages = Object.entries(bundle.index.locales[locale].pages).map(([slug, meta]) => ({
      slug,
      ...meta,
      markdown: fs.readFileSync(path.join(bundleDir, 'pages', locale, `${slug}.md`), 'utf8'),
    }));
    indexes[locale] = search.buildSearchIndex(pages, { lexer: marked.lexer, slugify: headingSlug });
  }
});

test.after(() => {
  removeTempDirSync(bundleDir);
});

const topHits = (locale, query) => search.searchManual(indexes[locale], query, { limit: 3 }).map((hit) => hit.slug);

test('the manual names every tool the model is offered, in both languages (#114, #952)', () => {
  assert.ok(catalog.length > 0, 'The registry returns no tools.');
  for (const locale of LOCALES) {
    const page = pageSource(locale, 'customising/built-in-tools');
    const missing = catalog.map((entry) => entry.name).filter((name) => !page.includes(`\`${name}\``));
    assert.deepEqual(
      missing,
      [],
      `These tools are offered to the model but missing from the ${locale} page `
        + `customising/built-in-tools.md: ${missing.join(', ')}. Without them the model `
        + 'reads in the manual that the app cannot do what it can.'
    );
  }
});

test('the manual explains every risk class the registry uses, in both languages (#114, #952)', () => {
  const classes = [...new Set(catalog.map((entry) => entry.riskClass))];
  for (const locale of LOCALES) {
    const page = pageSource(locale, 'safety/why-snotra-asks');
    const missing = classes
      .map((riskClass) => translateMessage(locale, { key: `tools.riskClass.${riskClass.replace(/-(\w)/g, (_, c) => c.toUpperCase())}` }))
      .filter((label) => !page.includes(`*${label}*`));
    assert.deepEqual(missing, [], `${locale}: safety/why-snotra-asks.md does not name ${missing.join(', ')}.`);
  }
});

test('snotra-capabilities is a lookup, not a second manual (#952)', () => {
  const body = skillText.replace(/^---[\s\S]*?\n---\r?\n/, '');
  // The load_skill result was cut by the context budget above ~13,300
  // characters (#947). A lookup stays far below; a skill that grows back
  // towards that size is collecting facts that belong in the manual.
  assert.ok(body.length < 6000, `The skill body has ${body.length} characters; move facts to the manual.`);
  assert.doesNotMatch(body, /^\|/m, 'Tables of features or settings belong in the manual.');
  for (const tool of ['get_configuration', 'search_manual', 'read_manual_page', 'list_release_notes', 'propose_config_change']) {
    assert.ok(skillText.includes(`\`${tool}\``), `The skill does not tell the model to use ${tool}.`);
  }
  // A run's own result is the only place that knows whether it was isolated (#405).
  assert.ok(skillText.includes('`sandbox.isolated`'));
});

test('the overview page the skill names exists in both languages (#952)', () => {
  assert.ok(skillText.includes(`\`${OVERVIEW_PAGE}\``), `The skill does not name ${OVERVIEW_PAGE}.`);
  for (const locale of LOCALES) {
    assert.ok(fs.existsSync(path.join(DOCS, locale === 'en' ? '' : locale, `${OVERVIEW_PAGE}.md`)), locale);
  }
});

test('keywords find the page, the user\'s sentence does not — which is why the skill asks for keywords (#952)', () => {
  // The search wants every word on the page, so a whole question finds nothing.
  assert.deepEqual(topHits('en', 'Can you let a command reach the internet?'), []);
  // The example from the skill.
  assert.equal(topHits('en', 'sandbox network')[0], 'safety/sandbox');

  const expectations = {
    en: [
      ['what can', OVERVIEW_PAGE],
      ['API key', 'getting-started/connect-a-model'],
      ['mode', 'safety/choose-a-mode'],
      ['switch off skill', 'customising/skills'],
      ['delete memory', 'customising/memory'],
      ['MCP server', 'customising/mcp-servers'],
      ['chat history', 'chatting/chat-history'],
    ],
    de: [
      ['was kann', OVERVIEW_PAGE],
      ['Sandbox Netzwerk', 'safety/sandbox'],
      ['API-Schlüssel', 'getting-started/connect-a-model'],
      ['Modus', 'safety/choose-a-mode'],
      ['Skill ausschalten', 'customising/skills'],
      ['Gedächtnis löschen', 'customising/memory'],
      ['MCP-Server', 'customising/mcp-servers'],
    ],
  };
  for (const [locale, pairs] of Object.entries(expectations)) {
    for (const [query, slug] of pairs) {
      assert.equal(topHits(locale, query)[0], slug, `${locale} "${query}": ${topHits(locale, query).join(', ')}`);
    }
  }
});

test('snotra-capabilities no longer claims that shell and internet are impossible (#114)', () => {
  // The two sentences that were wrong for four releases.
  assert.ok(!/Keine Shell, keine Befehle/.test(skillText));
  assert.ok(!/Kein Internetzugriff für dich/.test(skillText));
});
