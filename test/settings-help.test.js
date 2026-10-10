// Help links in the settings (#848): every `?` leads to a page and section
// that exist in the bundled manual, in English and in German — so renaming a
// heading in manual/ fails here instead of a link quietly landing at the top
// of a page. Then the buttons themselves: their names, the click, the header
// button that follows the open section, and main's side of the channel.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { marked } = require('marked');
const { bundleManual } = require('../scripts/bundle-manual.js');
const { importRenderer, setupRendererDom, loadRendererMarkup } = require('./helpers/dom.js');
const { cleanHelpTarget, registerManualOpenHandler } = require('../src/main/manual-window');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');

const LOCALES = ['en', 'de'];

let dom = null;
let help = null;
let links = null;
let i18n = null;
let targetDir = null;
let bundle = null;
const indexes = {};

test.before(async () => {
  dom = setupRendererDom();
  help = await importRenderer('components', 'SettingsHelp.js');
  links = await importRenderer('manual', 'settings-help-links.js');
  i18n = await importRenderer('i18n.js');
  const search = await importRenderer('manual', 'manual-search.js');
  const { headingSlug } = await importRenderer('file-views', 'markdown-document.js');
  targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-settings-help-'));
  bundle = bundleManual({ manualDir: path.join(__dirname, '..', 'manual'), targetDir });
  for (const locale of LOCALES) {
    const pages = Object.entries(bundle.index.locales[locale].pages).map(([slug, meta]) => ({
      slug,
      ...meta,
      markdown: fs.readFileSync(path.join(targetDir, 'pages', locale, `${slug}.md`), 'utf8'),
    }));
    // The search index splits a page at its headings with the anchors the
    // help window gives them, duplicates numbered — the same anchors a link
    // has to hit.
    indexes[locale] = new Map(search.buildSearchIndex(pages, { lexer: marked.lexer, slugify: headingSlug })
      .map((page) => [page.slug, page]));
  }
});

test.after(() => {
  dom?.cleanup();
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test('every help link leads to a page and section of the bundled manual, in both languages', () => {
  for (const [key, entry] of Object.entries(links.SETTINGS_HELP)) {
    assert.ok(Boolean(entry.section) !== Boolean(entry.title), `${key}: either a section or the page's title`);
    for (const locale of LOCALES) {
      const page = indexes[locale].get(entry.slug);
      assert.ok(page, `${key}: no page "${entry.slug}" in the ${locale} manual`);
      const target = links.settingsHelpTarget(key, locale);
      if (entry.section) {
        const section = page.sections.find((s) => s.heading === entry.section[locale]);
        assert.ok(section, `${key}: "${entry.section[locale]}" is not a heading of ${entry.slug} (${locale}); `
          + `it has: ${page.sections.map((s) => s.heading).filter(Boolean).join(' | ')}`);
        assert.equal(target.fragment, section.anchor, `${key}: the link names the anchor the window gives (${locale})`);
      } else {
        assert.equal(entry.title[locale], page.title, `${key}: the label is the page's title (${locale})`);
        assert.equal(target.fragment, '');
      }
    }
  }
});

test('the markup and the mapping name the same help links', () => {
  const markup = loadRendererMarkup();
  const inMarkup = new Set([...markup.matchAll(/data-manual-help="([^"]+)"/g)].map((m) => m[1]));
  const keys = Object.keys(links.SETTINGS_HELP);
  // The header's button starts on Models and takes the key of whichever
  // section is open; every other entry has a button of its own.
  const sectionKeys = keys.filter((key) => !key.startsWith('panel.'));
  for (const key of sectionKeys) assert.ok(inMarkup.has(key), `no button for "${key}" in index.html`);
  for (const key of inMarkup) assert.ok(keys.includes(key), `index.html names "${key}", the mapping does not`);
  const panels = [...markup.matchAll(/data-settings-panel="([^"]+)"/g)].map((m) => `panel.${m[1]}`);
  assert.deepEqual(keys.filter((key) => key.startsWith('panel.')).sort(), panels.sort(),
    'every section of the settings has a page for the header button');
});

function mount() {
  const { document } = dom;
  const calls = [];
  const root = document.getElementById('modal-settings');
  const controller = help.initSettingsHelp({ root, api: { openManual: async (target) => { calls.push(target); return { ok: true }; } } });
  return { document, root, calls, controller };
}

test('a ? names its target and opens the manual there, in English and in German', async () => {
  const { document, calls, controller } = mount();
  const button = document.querySelector('[data-manual-help="defaultMode"]');
  try {
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.getAttribute('aria-label'), 'Help: Give a folder a default mode');
    assert.equal(button.title, 'Help: Give a folder a default mode');
    button.click();
    assert.deepEqual(calls, [{ slug: 'safety/choose-a-mode', fragment: 'give-a-folder-a-default-mode' }]);

    i18n.setLocale('de', { force: true });
    assert.equal(button.getAttribute('aria-label'), 'Hilfe: Einem Ordner einen Standardmodus geben');
    button.click();
    assert.deepEqual(calls[1], { slug: 'safety/choose-a-mode', fragment: 'einem-ordner-einen-standardmodus-geben' });
  } finally {
    i18n.setLocale('en', { force: true });
    controller.refresh();
  }
});

test('the header button follows the open section, a page without a section opens at its top', () => {
  const { document, calls, controller } = mount();
  const button = document.getElementById('btn-settings-panel-help');
  assert.equal(button.getAttribute('aria-label'), 'Help: Manage your models');
  button.dataset.manualHelp = 'panel.memory';
  controller.refresh();
  assert.equal(button.getAttribute('aria-label'), 'Help: Let Snotra remember');
  button.click();
  assert.deepEqual(calls.at(-1), { slug: 'customising/memory', fragment: '' });
});

test('an unknown key hides its button instead of showing a ? that leads nowhere', () => {
  const { document, controller } = mount();
  const button = document.querySelector('[data-manual-help="python"]');
  button.dataset.manualHelp = 'no-such-entry';
  controller.refresh();
  assert.equal(button.hidden, true);
  button.dataset.manualHelp = 'python';
  controller.refresh();
  assert.equal(button.hidden, false);
});

test('main opens only what has the shape of a page and a heading', () => {
  assert.deepEqual(cleanHelpTarget({ slug: 'safety/choose-a-mode', fragment: 'give-a-folder-a-default-mode' }),
    { slug: 'safety/choose-a-mode', fragment: 'give-a-folder-a-default-mode' });
  assert.deepEqual(cleanHelpTarget({ slug: 'customising/settings', fragment: 'der-bereich-allgemein' }),
    { slug: 'customising/settings', fragment: 'der-bereich-allgemein' });
  assert.deepEqual(cleanHelpTarget({ slug: 'customising/memory' }), { slug: 'customising/memory', fragment: '' });
  for (const bad of [null, 'index', {}, { slug: '../secret' }, { slug: 'a//b' }, { slug: 'Safety/X' },
    { slug: 'index', fragment: 'a b' }, { slug: 'index', fragment: '#x' }, { slug: 'index', fragment: 'x'.repeat(121) },
    { slug: 'index', fragment: 3 }]) {
    assert.equal(cleanHelpTarget(bad), null, JSON.stringify(bad));
  }

  const handlers = new Map();
  const opened = [];
  registerManualOpenHandler({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    REQ,
    open: (target) => opened.push(target),
  });
  const handler = handlers.get(REQ.MANUAL_OPEN);
  assert.deepEqual(handler({}, { slug: 'safety/sandbox', fragment: 'give-one-program-more-room', extra: 1 }), { ok: true });
  assert.deepEqual(handler({}, { slug: 'https://example.com' }), { ok: false });
  assert.deepEqual(opened, [{ slug: 'safety/sandbox', fragment: 'give-one-program-more-room' }]);
});
