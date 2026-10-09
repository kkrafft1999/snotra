// The Markdown view in the content pane (#344), mounted by the real host
// against the real markup: the switch between preview and source, the images,
// the links, and what stays when the file changes on disk.
//
// `marked` is real, DOMPurify a pass-through stand-in (see
// test/markdown-document.test.js for why). Whether anything hostile survives
// is the smoke test's question, in real Chromium.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SKILL = [
  '---',
  'name: release',
  'description: Publishes a release.',
  '---',
  '# Release',
  '',
  'See [the steps](#steps), [contributing](../../CONTRIBUTING.md) and [the site](https://example.com).',
  '',
  '![Flow](../../docs/flow.png)',
  '',
  '![Badge](https://img.example/badge.svg)',
  '',
  '![Gone](missing.png)',
  '',
  '## Steps',
  '',
  'One, two.',
  '',
].join('\n');

async function mountPane(t, { files, openFile, images = {}, openExternal, listings = null } = {}) {
  const dom = setupRendererDom();
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };

  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const calls = { images: [], opened: [], external: [], listings: [], prefs: [] };
  const api = {
    setUIPrefs: async (patch) => {
      calls.prefs.push(patch);
      return {};
    },
    // The folder listing of the tree, which the view uses to see whether an
    // image changed before it reads it again (#640). Absent unless asked for.
    ...(listings && {
      readDirectory: async (dir, options) => {
        calls.listings.push([dir, options]);
        return { entries: listings[dir] ?? [], hidden: 0 };
      },
    }),
    readFile: async (p) => files[p] ?? { error: `ENOENT: ${p}` },
    readWorkspaceImage: async (p) => {
      calls.images.push(p);
      const entry = images[p];
      if (typeof entry === 'function') return entry();
      return entry ?? { ok: false, reason: 'not_found' };
    },
    openExternal: async (url) => {
      calls.external.push(url);
      return openExternal ? openExternal(url) : { ok: true };
    },
  };
  const host = createFileViewHost({
    api,
    getWorkspaceRoot: () => '/ws',
    openFile: async (p) => {
      calls.opened.push(p);
      return openFile ? openFile(p) : { ok: true };
    },
  });
  t.after(() => {
    host.dispose();
    delete globalThis.DOMPurify;
    dom.cleanup();
  });
  return { host, calls, api, images, listings };
}

/** A listing entry as main's readDirectory gives it: lstat's size and date. */
const listed = (p, size = 70, modified = 1) => ({ name: p.split('/').pop(), path: p, isDirectory: false, size, modified });

const png = (base64 = PNG_1PX, extra = {}) => ({ ok: true, mime: 'image/png', base64, mtimeMs: 1, size: 70, ...extra });
// Another valid-looking payload: the view only compares the bytes.
const PNG_OTHER = `${PNG_1PX.slice(0, -4)}AAA=`;

const file = (content) => ({ content, size: content.length, modified: 1 });
const item = (p) => ({ path: p, name: p.split('/').pop(), size: 1, modified: 1 });
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function settle() {
  for (let i = 0; i < 4; i += 1) await flush();
}

test('a .md file opens rendered, with the front matter above and the switch in the header', async (t) => {
  const { host } = await mountPane(t, { files: { '/ws/skills/release/SKILL.md': file(SKILL) } });
  assert.equal(await host.open(item('/ws/skills/release/SKILL.md')), true);
  await settle();

  assert.equal($('#preview-body > .file-view').dataset.view, 'markdown');
  assert.equal($('.md-doc h1').textContent, 'Release');
  assert.deepEqual($$('.md-front-matter dt').map((el) => el.textContent), ['name', 'description']);
  assert.equal($('.md-front-matter dd').textContent, 'release');

  const tools = $('#preview-tools');
  assert.equal(tools.hidden, false);
  const radios = $$('#preview-tools input[type="radio"]');
  assert.deepEqual(radios.map((r) => [r.value, r.checked]), [['preview', true], ['source', false]]);
  assert.equal(radios[0].name, radios[1].name, 'one group');
  assert.equal($('#preview-tools [role="radiogroup"]').getAttribute('aria-label'), 'Show as');
  assert.deepEqual($$('#preview-tools .ds-segmented__option').map((l) => l.textContent), ['Preview', 'Source']);
  assert.equal($('#preview-tools .ds-segmented__option span').lang, 'en', '"Preview" is English in German too');
  assert.equal($('#preview-content'), null, 'the source is only mounted when asked for');
});

test('the switch shows the source and back; the preview keeps its place', async (t) => {
  const { host } = await mountPane(t, { files: { '/ws/a.md': file('# A\n\ntext\n') } });
  await host.open(item('/ws/a.md'));
  await settle();

  const [preview, source] = $$('#preview-tools input[type="radio"]');
  source.checked = true;
  source.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal($('#preview-content').textContent, '# A\n\ntext\n');
  assert.equal($('.md-view').hidden, true);
  assert.equal($('.md-source').hidden, false);

  preview.checked = true;
  preview.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal($('.md-view').hidden, false);
  assert.equal($('.md-source').hidden, true);
});

test('the menu command toggles the Markdown view and nothing else', async (t) => {
  const { host } = await mountPane(t, {
    files: { '/ws/a.md': file('# A\n'), '/ws/b.txt': file('plain') },
  });
  assert.equal(host.runCommand('toggle-source'), false, 'nothing on show');

  await host.open(item('/ws/a.md'));
  await settle();
  assert.equal(host.runCommand('toggle-source'), true);
  assert.equal($('.md-view').hidden, true);
  assert.equal($$('#preview-tools input')[1].checked, true, 'the switch follows the shortcut');
  assert.equal(host.runCommand('something-else'), false);

  await host.open(item('/ws/b.txt'));
  assert.equal(host.runCommand('toggle-source'), false, 'the plain-text view knows no commands');
});

test('an external change re-renders in the mode the user chose', async (t) => {
  let content = '# One\n';
  const { host } = await mountPane(t, { files: { get '/ws/a.md'() { return file(content); } } });
  await host.open(item('/ws/a.md'));
  await settle();
  host.runCommand('toggle-source');

  content = '# Two\n';
  await host.refresh('/ws/a.md');
  await settle();
  assert.equal($('.md-view').hidden, true, 'still the source');
  assert.equal($('#preview-content').textContent, '# Two\n');
  assert.equal($('.md-doc h1').textContent, 'Two', 'the hidden preview is current as well');
});

test('images: relative to the file through the main process, the web never, data: as it is', async (t) => {
  const { host, calls } = await mountPane(t, {
    files: { '/ws/skills/release/SKILL.md': file(`${SKILL}\n![inline](data:image/png;base64,${PNG_1PX})\n`) },
    images: {
      '/ws/docs/flow.png': { ok: true, mime: 'image/png', base64: PNG_1PX, mtimeMs: 1, size: 70 },
    },
  });
  await host.open(item('/ws/skills/release/SKILL.md'));
  await settle();

  assert.deepEqual(calls.images.sort(), ['/ws/docs/flow.png', '/ws/skills/release/missing.png']);
  const loaded = $$('.md-doc img.md-image').map((img) => img.getAttribute('src'));
  assert.deepEqual(loaded, [`data:image/png;base64,${PNG_1PX}`, `data:image/png;base64,${PNG_1PX}`]);
  assert.equal($$('.md-doc img:not([src])').length, 0, 'no image is left without a decision');

  const placeholders = $$('.md-doc .chat-md-image');
  assert.equal(placeholders.length, 2);
  const remote = placeholders.find((el) => el.textContent.includes('Badge'));
  assert.match(remote.textContent, /Image from the web, not loaded/);
  assert.equal(remote.querySelector('.chat-md-image-source').textContent, 'https://img.example/badge.svg');
  const gone = placeholders.find((el) => el.textContent.includes('Gone'));
  assert.ok(gone.querySelector('.chat-md-image-reason').textContent.length > 0, 'says why');
});

test('a relative link opens the file through the tree; a missing one says so', async (t) => {
  const { host, calls } = await mountPane(t, {
    files: { '/ws/skills/release/SKILL.md': file(SKILL) },
    openFile: async (p) => (p.endsWith('CONTRIBUTING.md') ? { ok: false, reason: 'not-found' } : { ok: true }),
  });
  await host.open(item('/ws/skills/release/SKILL.md'));
  await settle();

  const link = $$('.md-doc a').find((a) => a.textContent === 'contributing');
  assert.equal(link.getAttribute('href'), '#', 'no real address that could navigate the window');
  assert.equal(link.hasAttribute('target'), false);
  link.click();
  await settle();
  assert.deepEqual(calls.opened, ['/ws/CONTRIBUTING.md']);
  const notice = $('.md-notice');
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.textContent, '../../CONTRIBUTING.md does not exist in the open folder.');
});

test('an external link goes to the main process, and a failure is shown', async (t) => {
  const { host, calls } = await mountPane(t, {
    files: { '/ws/a.md': file('[site](https://example.com)\n') },
    openExternal: async () => ({ ok: false, error: 'No browser.' }),
  });
  await host.open(item('/ws/a.md'));
  await settle();

  const link = $('.md-doc a');
  assert.ok(link.classList.contains('md-link--external'));
  assert.equal(link.title, 'https://example.com');
  link.click();
  await settle();
  assert.deepEqual(calls.external, ['https://example.com']);
  assert.equal($('.md-notice').textContent, 'No browser.');
});

test('an anchor link scrolls to its heading inside the view', async (t) => {
  const { host, calls } = await mountPane(t, { files: { '/ws/a.md': file(SKILL) } });
  await host.open(item('/ws/a.md'));
  await settle();

  const heading = $('.md-doc [data-md-anchor="steps"]');
  let scrolled = false;
  heading.scrollIntoView = () => { scrolled = true; };
  $$('.md-doc a').find((a) => a.textContent === 'the steps').click();
  await settle();
  assert.equal(scrolled, true);
  assert.deepEqual(calls.opened, []);
});

test('an empty file says so instead of showing a blank pane', async (t) => {
  const { host } = await mountPane(t, { files: { '/ws/empty.md': file('  \n') } });
  await host.open(item('/ws/empty.md'));
  await settle();
  assert.equal($('.md-doc').textContent, 'This file is empty.');
});

test('a link clicked after the file changed does not reach the tree', async (t) => {
  const { host, calls } = await mountPane(t, {
    files: { '/ws/a.md': file('[b](b.md)\n'), '/ws/c.txt': file('c') },
  });
  await host.open(item('/ws/a.md'));
  await settle();
  const link = $('.md-doc a');
  await host.open(item('/ws/c.txt'));
  link.click();
  await settle();
  assert.deepEqual(calls.opened, [], 'the view is gone, its links with it');
});

// ── Images that change on disk (#640) ───────────────────────────────────────

const imageSrc = () => $('.md-doc img.md-image')?.getAttribute('src') ?? null;

test('an image rewritten on disk shows its new content after a refresh of the same text', async (t) => {
  const { host, calls, images } = await mountPane(t, {
    files: { '/ws/README.md': file('# Readme\n\n![Diagram](diagram.png)\n') },
    images: { '/ws/diagram.png': png() },
  });
  await host.open(item('/ws/README.md'));
  await settle();
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_1PX}`);
  const article = $('.md-doc h1');

  images['/ws/diagram.png'] = png(PNG_OTHER);
  await host.refresh('/ws/README.md');
  await settle();
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_OTHER}`);
  assert.deepEqual(calls.images, ['/ws/diagram.png', '/ws/diagram.png']);
  assert.equal($('.md-doc h1') === article, true, 'the text was not rendered again');
});

test('an image rewritten on disk shows its new content after a click on the file and after a text change', async (t) => {
  let content = '# Readme\n\n![Diagram](diagram.png)\n';
  const { host, images } = await mountPane(t, {
    files: { get '/ws/README.md'() { return file(content); } },
    images: { '/ws/diagram.png': png() },
  });
  await host.open(item('/ws/README.md'));
  await settle();

  images['/ws/diagram.png'] = png(PNG_OTHER);
  await host.open(item('/ws/README.md'));
  await settle();
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_OTHER}`, 'clicking the README again');

  images['/ws/diagram.png'] = png();
  content = '# Readme, edited\n\n![Diagram](diagram.png)\n';
  await host.refresh('/ws/README.md');
  await settle();
  assert.equal($('.md-doc h1').textContent, 'Readme, edited');
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_1PX}`, 'after the text changed');
});

test('an unchanged image is not swapped, and shows from the cache while it is read again', async (t) => {
  let release;
  const { host, images } = await mountPane(t, {
    files: { '/ws/README.md': file('![Diagram](diagram.png)\n') },
    images: { '/ws/diagram.png': png() },
  });
  await host.open(item('/ws/README.md'));
  await settle();
  const img = $('.md-doc img.md-image');
  let assigned = 0;
  const { set } = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(img), 'src');
  Object.defineProperty(img, 'src', { configurable: true, set(value) { assigned += 1; set.call(this, value); } });

  images['/ws/diagram.png'] = () => new Promise((resolve) => { release = () => resolve(png()); });
  const refreshed = host.refresh('/ws/README.md');
  await settle();
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_1PX}`, 'still on show while main is asked');
  release();
  await refreshed;
  await settle();
  assert.equal(assigned, 0, 'the same bytes are not set again');
});

test('a gone image turns into the placeholder, and back once it is there again', async (t) => {
  const { host, images } = await mountPane(t, {
    files: { '/ws/README.md': file('Text ![Diagram](diagram.png) inline.\n') },
    images: { '/ws/diagram.png': png() },
  });
  await host.open(item('/ws/README.md'));
  await settle();

  delete images['/ws/diagram.png'];
  await host.refresh('/ws/README.md');
  await settle();
  assert.equal(imageSrc(), null);
  assert.match($('.md-doc .chat-md-image').textContent, /Diagram/);

  images['/ws/diagram.png'] = png(PNG_OTHER);
  await host.refresh('/ws/README.md');
  await settle();
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_OTHER}`);
  assert.equal($('.md-doc .chat-md-image'), null);
  assert.equal($('.md-doc img.md-image').alt, 'Diagram', 'the same image element, alt text and all');
});

test('an image that cannot be decoded ends in the placeholder, not a broken icon', async (t) => {
  const { host } = await mountPane(t, {
    files: { '/ws/README.md': file('# Readme\n\n![Diagram](diagram.png)\n') },
    images: { '/ws/diagram.png': png() },
  });
  await host.open(item('/ws/README.md'));
  await settle();

  // What Chromium reports for bytes that pass main's signature check only.
  $('.md-doc img.md-image').dispatchEvent(new Event('error'));
  const placeholder = $('.md-doc .chat-md-image');
  assert.ok(placeholder, 'the placeholder stands where the image was');
  assert.equal(placeholder.querySelector('.chat-md-image-reason').textContent, 'Image is damaged');
  assert.equal(placeholder.getAttribute('aria-label'), 'Diagram: Image is damaged');
  assert.equal($('.md-doc img'), null);

  // The same broken bytes again: it stays the placeholder instead of flashing.
  await host.refresh('/ws/README.md');
  await settle();
  assert.equal($('.md-doc img'), null);
});

test('the cache of a document holds 24 images at most, and four reads run at a time', async (t) => {
  const names = Array.from({ length: 30 }, (_, i) => `img${i}.png`);
  const images = Object.fromEntries(names.map((name) => [`/ws/${name}`, png()]));
  let content = names.map((name) => `![${name}](${name})`).join('\n\n');
  const { host } = await mountPane(t, {
    files: { get '/ws/README.md'() { return file(content); } },
    images,
  });
  await host.open(item('/ws/README.md'));
  await settle();
  assert.equal($$('.md-doc img.md-image[src]').length, 30);

  // Main is slow now: what shows at once after the text changed comes from
  // the cache, and the reads queue up four at a time.
  const pending = [];
  let inFlight = 0;
  let most = 0;
  for (const name of names) {
    images[`/ws/${name}`] = () => new Promise((resolve) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      pending.push(() => { inFlight -= 1; resolve(png()); });
    });
  }
  content = `# Images\n\n${content}`;
  const refreshed = host.refresh('/ws/README.md');
  await settle();
  assert.equal($$('.md-doc img.md-image[src]').length, 24);
  while (pending.length > 0) {
    pending.shift()();
    await settle();
  }
  await refreshed;
  assert.equal(most, 4);
  assert.equal($$('.md-doc img.md-image[src]').length, 30);
});

test('a language switch renders the text anew but reads no image again (#640)', async (t) => {
  const { host, calls } = await mountPane(t, {
    files: { '/ws/README.md': file('![Diagram](diagram.png) and ![Gone](gone.png)\n') },
    images: { '/ws/diagram.png': png() },
  });
  const { setLocale } = await importRenderer('i18n.js');
  t.after(() => setLocale('en', { force: true }));
  await host.open(item('/ws/README.md'));
  await settle();
  assert.equal(calls.images.length, 2);

  setLocale('de', { force: true });
  await settle();
  assert.equal(calls.images.length, 2, 'neither the image nor the missing one is asked for again');
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_1PX}`);
  assert.equal($('.md-doc .chat-md-image-reason').textContent, 'Bild nicht gefunden', 'the reason in the new language');
});

test('a revalidation reads an image only when the listing says it changed (#640)', async (t) => {
  const { host, calls, images, listings } = await mountPane(t, {
    files: { '/ws/README.md': file('![Diagram](docs/img/diagram.png)\n') },
    images: { '/ws/docs/img/diagram.png': png(PNG_1PX, { size: 70, mtimeMs: 5 }) },
    listings: { '/ws/docs/img': [listed('/ws/docs/img/diagram.png', 70, 5)] },
  });
  await host.open(item('/ws/README.md'));
  await settle();
  assert.equal(calls.images.length, 1);

  await host.refresh('/ws/README.md');
  await settle();
  assert.equal(calls.images.length, 1, 'same size and date: no bytes over the channel');
  assert.deepEqual(calls.listings, [['/ws/docs/img', { showHidden: true }]]);

  images['/ws/docs/img/diagram.png'] = png(PNG_OTHER, { size: 70, mtimeMs: 9 });
  listings['/ws/docs/img'] = [listed('/ws/docs/img/diagram.png', 70, 9)];
  await host.refresh('/ws/README.md');
  await settle();
  assert.equal(calls.images.length, 2);
  assert.equal(imageSrc(), `data:image/png;base64,${PNG_OTHER}`);
});

test('a revalidation for other folders checks only the images that lie in them', async (t) => {
  const { host, calls, images, listings } = await mountPane(t, {
    files: { '/ws/README.md': file('![A](a/x.png)\n\n![B](b/y.png)\n') },
    images: {
      '/ws/a/x.png': png(PNG_1PX, { mtimeMs: 1 }),
      '/ws/b/y.png': png(PNG_1PX, { mtimeMs: 1 }),
    },
    listings: { '/ws/a': [listed('/ws/a/x.png')], '/ws/b': [listed('/ws/b/y.png')] },
  });
  await host.open(item('/ws/README.md'));
  await settle();

  images['/ws/b/y.png'] = png(PNG_OTHER, { mtimeMs: 2 });
  listings['/ws/b'] = [listed('/ws/b/y.png', 70, 2)];
  await host.revalidate(['/ws/b']);
  await settle();
  assert.deepEqual(calls.listings.map(([dir]) => dir), ['/ws/b'], 'folder a is not even listed');
  assert.deepEqual($$('.md-doc img.md-image').map((img) => img.getAttribute('src').slice(-4)), [PNG_1PX.slice(-4), 'AAA=']);
});

test('a missing image keeps its placeholder node while the reason stays the same', async (t) => {
  const { host } = await mountPane(t, {
    files: { '/ws/README.md': file('Before ![Gone](gone.png) after.\n') },
  });
  await host.open(item('/ws/README.md'));
  await settle();
  const placeholder = $('.md-doc .chat-md-image');

  await host.refresh('/ws/README.md');
  await settle();
  assert.equal($('.md-doc .chat-md-image') === placeholder, true, 'a selection across it survives');
});

// ── Links (#641) ────────────────────────────────────────────────────────────

test('an anchor link moves the focus to its heading', async (t) => {
  const { host } = await mountPane(t, { files: { '/ws/a.md': file(SKILL) } });
  await host.open(item('/ws/a.md'));
  await settle();

  const link = $$('.md-doc a').find((a) => a.textContent === 'the steps');
  link.focus();
  link.click();
  await settle();
  const heading = $('.md-doc [data-md-anchor="steps"]');
  assert.equal(document.activeElement === heading, true, 'the next Tab goes on from the heading');
  assert.equal(heading.getAttribute('tabindex'), '-1', 'focusable by script, no Tab stop of its own');
});

test('a link into another file follows its fragment there', async (t) => {
  let hostRef = null;
  const { host, calls } = await mountPane(t, {
    files: {
      '/ws/README.md': file('See [the setup](docs/guide.md#setup).\n'),
      '/ws/docs/guide.md': file('# Guide\n\nIntro.\n\n## Setup\n\nSteps.\n'),
    },
    // What the tree does: select the row, whose click opens the file.
    openFile: async (p) => {
      void hostRef.open(item(p));
      return { ok: true };
    },
  });
  hostRef = host;
  const scrolled = [];
  t.mock.method(HTMLElement.prototype, 'scrollIntoView', function scrollIntoView() {
    scrolled.push(this.getAttribute('data-md-anchor'));
  });
  await host.open(item('/ws/README.md'));
  await settle();

  $('.md-doc a').click();
  await settle();
  assert.deepEqual(calls.opened, ['/ws/docs/guide.md']);
  assert.equal($('#preview-filename').textContent, 'guide.md');
  const heading = $('.md-doc [data-md-anchor="setup"]');
  assert.equal(document.activeElement === heading, true);
  assert.ok(scrolled.includes('setup'));

  // Opened again from the tree, the file starts at the top.
  scrolled.length = 0;
  await host.open(item('/ws/README.md'));
  await host.open(item('/ws/docs/guide.md'));
  await settle();
  assert.deepEqual(scrolled, []);
});

test('a fragment the other file does not have says so there', async (t) => {
  let hostRef = null;
  const { host } = await mountPane(t, {
    files: {
      '/ws/README.md': file('[Gone](guide.md#nowhere)\n'),
      '/ws/guide.md': file('# Guide\n'),
    },
    openFile: async (p) => {
      void hostRef.open(item(p));
      return { ok: true };
    },
  });
  hostRef = host;
  await host.open(item('/ws/README.md'));
  await settle();
  $('.md-doc a').click();
  await settle();
  assert.equal($('#preview-filename').textContent, 'guide.md');
  assert.equal($('.md-notice').textContent, 'There is no heading #nowhere in this file.');
});

test('a link to a heading of the same file by its name stays in the file', async (t) => {
  const { host, calls } = await mountPane(t, {
    files: { '/ws/docs/a.md': file('[Down](a.md#steps)\n\n## Steps\n') },
  });
  await host.open(item('/ws/docs/a.md'));
  await settle();
  $('.md-doc a').click();
  await settle();
  assert.deepEqual(calls.opened, []);
  assert.equal(document.activeElement === $('.md-doc [data-md-anchor="steps"]'), true);
});

test('tooltips and notices show a path as it was written, not percent-encoded', async (t) => {
  const { host, calls } = await mountPane(t, {
    files: { '/ws/README.md': file('[grün](notizen/grün.md) and [plot](plot%231.md?x=1#top)\n') },
    openFile: async () => ({ ok: false, reason: 'not-found' }),
  });
  await host.open(item('/ws/README.md'));
  await settle();

  const [green, plot] = $$('.md-doc a');
  assert.equal(green.title, 'notizen/grün.md');
  assert.equal(plot.title, 'plot#1.md', 'query and fragment are not part of the name');
  green.click();
  await settle();
  assert.equal($('.md-notice').textContent, 'notizen/grün.md does not exist in the open folder.');
  plot.click();
  await settle();
  assert.deepEqual(calls.opened, ['/ws/notizen/grün.md', '/ws/plot#1.md']);
});

test('link attributes the document writes itself do nothing', async (t) => {
  const { host, calls } = await mountPane(t, {
    files: {
      '/ws/a.md': file('<a data-link-kind="file" data-target="/etc/hosts">x</a> <a data-link-kind="external" data-anchor="y">y</a>\n'),
    },
  });
  await host.open(item('/ws/a.md'));
  await settle();
  for (const link of $$('.md-doc a')) {
    assert.equal(link.hasAttribute('data-link-kind'), false);
    link.click();
  }
  await settle();
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.external, []);
});

// #822: back in the history, a Markdown file comes back as it was left — the
// same side of the switch, the same place in it.
async function mountWithHistory(t, files) {
  let host = null;
  const pane = await mountPane(t, {
    files,
    openFile: async (p) => {
      await host.open(item(p));
      return { ok: true };
    },
  });
  host = pane.host;
  return pane;
}

test('back to a Markdown file restores where the preview was scrolled to (#822)', async (t) => {
  const { host } = await mountWithHistory(t, { '/ws/a.md': file('# A\n\ntext\n'), '/ws/b.md': file('# B\n') });
  await host.open(item('/ws/a.md'));
  await settle();
  $('.md-view').scrollTop = 300;
  await host.open(item('/ws/b.md'));
  await settle();

  assert.equal(await host.goBack(), true);
  await settle();
  assert.equal(host.openPath(), '/ws/a.md');
  assert.equal($('.md-view').scrollTop, 300);
  assert.equal($('.md-view').hidden, false);
});

test('back to a Markdown file left in the source shows the source again (#822)', async (t) => {
  const { host } = await mountWithHistory(t, { '/ws/a.md': file('# A\n\ntext\n'), '/ws/b.md': file('# B\n') });
  await host.open(item('/ws/a.md'));
  await settle();
  host.runCommand('toggle-source');
  $('#preview-content').scrollTop = 120;
  await host.open(item('/ws/b.md'));
  await settle();

  await host.goBack();
  await settle();
  assert.equal($('.md-view').hidden, true);
  assert.equal($('.md-source').hidden, false);
  assert.equal($$('#preview-tools input')[1].checked, true, 'the switch says so too');
  assert.equal($('#preview-content').scrollTop, 120);
});

/** The zoom group in the header (#829), next to the switch. */
function zoomTools() {
  return {
    group: $('#preview-tools .md-zoom'),
    out: $('#preview-tools .pdf-tools__zoom-out'),
    value: $('#preview-tools .pdf-tools__zoom'),
    in: $('#preview-tools .pdf-tools__zoom-in'),
  };
}

const zoomOf = () => $('.md-doc').style.getPropertyValue('--md-zoom');

async function resetZoom() {
  const { restoreMarkdownZoom } = await importRenderer('file-views', 'markdown-zoom.js');
  restoreMarkdownZoom(undefined);
}

test('the header zooms the whole document and remembers it for every Markdown file (#829)', async (t) => {
  await resetZoom();
  const { host, calls } = await mountPane(t, { files: { '/ws/a.md': file('# A\n'), '/ws/b.md': file('# B\n') } });
  await host.open(item('/ws/a.md'));
  await settle();

  const tools = zoomTools();
  assert.equal(tools.group.getAttribute('aria-label'), 'Zoom');
  assert.equal(tools.out.getAttribute('aria-label'), 'Zoom out');
  assert.equal(tools.in.getAttribute('aria-label'), 'Zoom in');
  assert.equal(tools.value.textContent, '100\u00a0%');
  assert.equal(zoomOf(), '1');
  assert.deepEqual(calls.prefs, [], 'opening a file stores nothing');

  tools.in.click();
  tools.in.click();
  assert.equal(zoomTools().value.textContent, '125\u00a0%');
  assert.equal(zoomOf(), '1.25');
  assert.deepEqual(calls.prefs, [{ markdownZoom: 1.1 }, { markdownZoom: 1.25 }]);

  await host.open(item('/ws/b.md'));
  await settle();
  assert.equal($('.md-doc h1').textContent, 'B');
  assert.equal(zoomTools().value.textContent, '125\u00a0%', 'the next file opens at the same size');
  assert.equal(zoomOf(), '1.25');
});

test('the zoom stops at 50 % and 300 %, and the keys zoom while the preview has focus (#829)', async (t) => {
  await resetZoom();
  const { host } = await mountPane(t, { files: { '/ws/a.md': file('# A\n') } });
  await host.open(item('/ws/a.md'));
  await settle();

  for (let i = 0; i < 20; i += 1) zoomTools().out.click();
  assert.equal(zoomTools().value.textContent, '50\u00a0%');
  assert.equal(zoomTools().out.disabled, true);
  for (let i = 0; i < 20; i += 1) zoomTools().in.click();
  assert.equal(zoomTools().value.textContent, '300\u00a0%');
  assert.equal(zoomTools().in.disabled, true);

  const view = $('.md-view');
  const key = (k, extra = {}) => {
    const event = new KeyboardEvent('keydown', { key: k, metaKey: true, bubbles: true, cancelable: true, ...extra });
    view.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(key('0'), true);
  assert.equal(zoomTools().value.textContent, '100\u00a0%');
  assert.equal(key('-'), true);
  assert.equal(zoomTools().value.textContent, '90\u00a0%');
  assert.equal(key('='), true);
  assert.equal(key('+'), true);
  assert.equal(zoomTools().value.textContent, '110\u00a0%');
  assert.equal(key('+', { metaKey: false }), false, 'without the modifier the key is the page\'s');
  assert.equal(key('+', { altKey: true }), false);
  assert.equal(zoomTools().value.textContent, '110\u00a0%');
});

test('the zoom leaves the header while the source is on show (#829)', async (t) => {
  await resetZoom();
  const { host } = await mountPane(t, { files: { '/ws/a.md': file('# A\n') } });
  await host.open(item('/ws/a.md'));
  await settle();

  const [preview, source] = $$('#preview-tools input[type="radio"]');
  source.checked = true;
  source.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(zoomTools().group, null);
  assert.equal($$('#preview-tools input[type="radio"]').length, 2, 'the switch stays');

  $$('#preview-tools input[type="radio"]')[0].checked = true;
  $$('#preview-tools input[type="radio"]')[0].dispatchEvent(new Event('change', { bubbles: true }));
  assert.notEqual(zoomTools().group, null);
  assert.equal(preview.isConnected, true, 'the same switch, not a new one');
});

test('a stored zoom outside the range falls back into it, an unusable one to 100 % (#829)', async () => {
  const { restoreMarkdownZoom, markdownZoom } = await importRenderer('file-views', 'markdown-zoom.js');
  restoreMarkdownZoom(12);
  assert.equal(markdownZoom(), 3);
  restoreMarkdownZoom('large');
  assert.equal(markdownZoom(), 1);
});
