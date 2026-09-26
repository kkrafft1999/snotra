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

async function mountPane(t, { files, openFile, images = {}, openExternal } = {}) {
  const dom = setupRendererDom();
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };

  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const calls = { images: [], opened: [], external: [] };
  const api = {
    readFile: async (p) => files[p] ?? { error: `ENOENT: ${p}` },
    readWorkspaceImage: async (p) => {
      calls.images.push(p);
      return images[p] ?? { ok: false, reason: 'not_found' };
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
  return { host, calls, api };
}

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
