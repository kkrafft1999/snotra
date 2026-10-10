'use strict';

/**
 * Packs the user manual into the app (#790).
 *
 * The web manual is built by Starlight from `manual/`; the app does not run
 * that build. It takes the same sources — the Markdown pages, the chapter list
 * in `manual/chapters.json` and the screenshots — and copies them into
 * `src/manual/`, which electron-forge packs like every other part of `src/`.
 * Next to them goes `index.json`: per language the chapters with their pages in
 * sidebar order, and per page its title and description, so that the help
 * window needs no front-matter parser and no directory listing at run time.
 *
 * Run by `scripts/sync-renderer-vendor.js`, so `npm start`, `npm test` and every
 * packaging script see a fresh copy.
 */

const fs = require('fs');
const path = require('path');

const LOCALES = ['en', 'de'];
/** The locale whose pages sit at the root of `docs/`; the others in a folder of their name. */
const ROOT_LOCALE = 'en';
const SCREENSHOT_FILE = /^[a-z0-9-]+\.(?:en|de)\.(?:light|dark)\.webp$/;

/**
 * The front matter of a manual page. The pages only use `title`,
 * `description` and `sidebar.order` (checked by the tests), so this reads
 * exactly those instead of pulling in a YAML parser.
 */
function parsePage(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { title: '', description: '', order: null, body: normalized };
  const meta = { title: '', description: '', order: null };
  let section = null;
  for (const line of match[1].split('\n')) {
    const top = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (top) {
      section = top[2] === '' ? top[1] : null;
      if (top[1] === 'title') meta.title = unquote(top[2]);
      if (top[1] === 'description') meta.description = unquote(top[2]);
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z]+):\s*(.*)$/);
    if (nested && section === 'sidebar' && nested[1] === 'order') {
      const order = Number(nested[2]);
      meta.order = Number.isFinite(order) ? order : null;
    }
  }
  return { ...meta, body: normalized.slice(match[0].length).replace(/^\n+/, '') };
}

function unquote(value) {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  return quoted ? quoted[2] : trimmed;
}

/** `getting-started/install.md` → `getting-started/install`; `index.md` → `index`. */
function slugOf(relativePath) {
  return relativePath.split(path.sep).join('/').replace(/\.md$/, '');
}

function listPages(localeDir) {
  const pages = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // The German pages are a folder of the English root; skip it there.
        if (prefix === '' && LOCALES.includes(entry.name)) continue;
        walk(path.join(dir, entry.name), path.join(prefix, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        pages.push(path.join(prefix, entry.name));
      }
    }
  };
  walk(localeDir, '');
  return pages.sort();
}

/** Sidebar order inside a chapter, the way Starlight's `autogenerate` sorts. */
function bySidebarOrder(a, b) {
  const orderA = a.order ?? Number.MAX_VALUE;
  const orderB = b.order ?? Number.MAX_VALUE;
  if (orderA !== orderB) return orderA - orderB;
  return a.slug.localeCompare(b.slug);
}

/**
 * Builds the index and copies the pages and screenshots.
 * @returns {{ index: object, pageCount: number, screenshotCount: number }}
 */
function bundleManual({ manualDir, targetDir }) {
  const docsDir = path.join(manualDir, 'src', 'content', 'docs');
  const chapters = JSON.parse(fs.readFileSync(path.join(manualDir, 'chapters.json'), 'utf8'));

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const index = { locales: {} };
  let pageCount = 0;
  for (const locale of LOCALES) {
    const localeDir = locale === ROOT_LOCALE ? docsDir : path.join(docsDir, locale);
    const pages = {};
    const entries = [];
    for (const relative of listPages(localeDir)) {
      const slug = slugOf(relative);
      const { body, ...meta } = parsePage(fs.readFileSync(path.join(localeDir, relative), 'utf8'));
      const chapter = slug.includes('/') ? slug.slice(0, slug.indexOf('/')) : null;
      pages[slug] = { title: meta.title, description: meta.description, chapter };
      entries.push({ slug, order: meta.order, chapter });
      const target = path.join(targetDir, 'pages', locale, `${slug}.md`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      pageCount += 1;
    }

    const nav = [];
    if (pages[chapters.overview.slug]) {
      nav.push({ slug: chapters.overview.slug, label: chapters.overview.label[locale] });
    }
    for (const { directory, label } of chapters.chapters) {
      const inChapter = entries.filter((entry) => entry.chapter === directory).sort(bySidebarOrder);
      if (inChapter.length === 0) continue;
      nav.push({ chapter: directory, label: label[locale], pages: inChapter.map((entry) => entry.slug) });
    }
    index.locales[locale] = { nav, pages };
  }
  fs.writeFileSync(path.join(targetDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  const screenshotsSource = path.join(manualDir, 'public', 'screenshots');
  const screenshotsTarget = path.join(targetDir, 'screenshots');
  fs.mkdirSync(screenshotsTarget, { recursive: true });
  let screenshotCount = 0;
  for (const name of fs.readdirSync(screenshotsSource)) {
    if (!SCREENSHOT_FILE.test(name)) continue;
    fs.copyFileSync(path.join(screenshotsSource, name), path.join(screenshotsTarget, name));
    screenshotCount += 1;
  }

  return { index, pageCount, screenshotCount };
}

module.exports = { bundleManual, parsePage, LOCALES };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const { pageCount, screenshotCount } = bundleManual({
    manualDir: path.join(root, 'manual'),
    targetDir: path.join(root, 'src', 'manual'),
  });
  console.log(`Manual bundled: ${pageCount} pages, ${screenshotCount} screenshots → src/manual/`);
}
