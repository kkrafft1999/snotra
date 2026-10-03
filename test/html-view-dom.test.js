// HTML files in the content pane (#479), mounted by the real host against the
// real markup. The page itself lives in the main process and is replaced by a
// stand-in of `api.htmlPreview`; what Chromium does with a real page is the
// smoke test's question (e2e/smoke.test.mjs). Tested here is everything
// around it: the channel, where the view is told to go and when it hides, the
// notice, every state instead of the page, the source, focus and links.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const item = (name, extra = {}) => ({ path: `/ws/${name}`, name, size: 120, modified: 1, ...extra });
const PAGE_ID = 'a'.repeat(32);

function fakePreview({ open } = {}) {
  const calls = { open: [], bounds: [], checks: 0, reloads: 0, focus: 0, closed: [], browser: [] };
  let listener = null;
  let checkResult = { ok: true, reloaded: false, size: 120, mtimeMs: 1 };
  const preview = {
    calls,
    async open(filePath, options) {
      calls.open.push({ filePath, options });
      return open ? open(filePath, options) : { ok: true, id: PAGE_ID, size: 120, mtimeMs: 1 };
    },
    async setBounds(id, bounds) { calls.bounds.push({ id, bounds }); return { ok: true }; },
    async check() { calls.checks += 1; return checkResult; },
    async reload() { calls.reloads += 1; return { ok: true }; },
    async focus() { calls.focus += 1; return { ok: true }; },
    async close(id) { calls.closed.push(id); return { ok: true }; },
    async openInBrowser(filePath) { calls.browser.push(filePath); return { ok: filePath !== '/ws/fails.html' }; },
    onEvent(fn) {
      listener = fn;
      return () => { listener = null; };
    },
    emit(event) { listener?.({ id: PAGE_ID, ...event }); },
    get listening() { return listener !== null; },
    setCheckResult(result) { checkResult = result; },
    lastBounds() { return calls.bounds.at(-1)?.bounds; },
  };
  return preview;
}

async function mountPane(t, { preview = fakePreview(), files = {}, openFile } = {}) {
  const dom = setupRendererDom();
  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const { fileViews } = await importRenderer('file-views', 'registry.js');
  const i18n = await importRenderer('i18n.js');
  const opened = [];
  const api = {
    htmlPreview: preview,
    readFile: async (p) => (p in files ? { content: files[p], size: files[p].length, modified: 1 } : { error: 'gone', reason: 'missing' }),
  };
  const host = createFileViewHost({
    api,
    registry: fileViews,
    getWorkspaceRoot: () => '/ws',
    openFile: async (path) => {
      opened.push(path);
      return openFile ? openFile(path) : { ok: true };
    },
  });
  // happy-dom has no layout: the stage gets a box of its own.
  const stageBox = { left: 600, top: 80, right: 1000, bottom: 700, width: 400, height: 620 };
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function box() {
    return this.classList?.contains('html-view__stage') ? { ...stageBox } : original.call(this);
  };
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  t.after(() => {
    window.HTMLElement.prototype.getBoundingClientRect = original;
    host.dispose();
    dom.cleanup();
  });
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { host, api, preview, opened, i18n, settle, stageBox, $: (s) => document.querySelector(s) };
}

test('html and htm get the HTML view, ahead of the plain text', async () => {
  const { fileViews } = await importRenderer('file-views', 'registry.js');
  assert.equal(fileViews.resolve({ name: 'index.html' }).id, 'html');
  assert.equal(fileViews.resolve({ name: 'OLD.HTM' }).id, 'html');
  assert.deepEqual(fileViews.candidatesFor({ name: 'index.html' }).map((view) => view.id), ['html', 'plain-text']);
});

test('the page opens by its path, and the view goes where the stage is, inside its edge', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  assert.deepEqual(pane.preview.calls.open, [{ filePath: '/ws/index.html', options: { fragment: '' } }]);
  assert.equal(pane.$('.file-view').dataset.view, 'html');
  assert.equal(pane.$('.html-view__stage').hidden, false);
  assert.deepEqual(pane.preview.lastBounds(), { x: 602, y: 82, width: 396, height: 616 });
  // The tools: Preview | Source, Reload, Open in browser — all labelled.
  const tools = pane.$('#preview-tools');
  assert.ok(tools.querySelector('.file-view-mode-switch'));
  assert.equal(tools.querySelector('.html-tools__reload').getAttribute('aria-label'), 'Reload');
  assert.equal(tools.querySelector('.html-tools__browser').getAttribute('aria-label'), 'Open in browser');
});

test('while a dialog of the app is open, the page is hidden', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  const settings = document.getElementById('modal-settings');
  settings.classList.remove('hidden');
  await pane.settle();
  assert.equal(pane.preview.lastBounds(), null);
  settings.classList.add('hidden');
  await pane.settle();
  assert.ok(pane.preview.lastBounds());
});

test('a stage with no room — the column hidden — hides the page', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  pane.stageBox.right = pane.stageBox.left;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pane.preview.lastBounds(), null);
});

test('what the page was refused is counted, and listed on demand', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  assert.equal(pane.$('.html-view__notice').hidden, true);

  pane.preview.emit({
    type: 'blocked',
    total: 3,
    entries: [
      { url: 'https://cdn.example.com/lib.js', reason: 'network' },
      { url: '/etc/passwd', reason: 'outside-workspace' },
      { url: 'img/logo.png', reason: 'not-found' },
    ],
  });
  await pane.settle();
  const notice = pane.$('.html-view__notice');
  assert.equal(notice.hidden, false);
  assert.match(pane.$('.html-view__notice-text--blocked').textContent, /^3 requests blocked\. The preview stays offline/);
  const toggle = pane.$('.html-view__notice-row--blocked .html-view__notice-button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(pane.$('.html-view__blocked').hidden, true);

  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const rows = [...document.querySelectorAll('.html-view__blocked-item')].map((row) => row.textContent);
  assert.deepEqual(rows, [
    'Networkhttps://cdn.example.com/lib.js',
    'Outside the folder/etc/passwd',
    'Missingimg/logo.png',
  ]);

  // A new document starts with an empty list, and the notice goes.
  pane.preview.emit({ type: 'blocked', total: 0, entries: [] });
  await pane.settle();
  assert.equal(notice.hidden, true);
});

test('beyond the listed ones the notice says how many more', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  pane.preview.emit({ type: 'blocked', total: 205, entries: [{ url: 'https://a.example/', reason: 'network' }] });
  await pane.settle();
  pane.$('.html-view__notice-row--blocked .html-view__notice-button').click();
  assert.equal(pane.$('.html-view__blocked-more').textContent, 'and 204 more');
});

test('a page that hangs or ends says so, with a way to reload', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  pane.preview.emit({ type: 'unresponsive' });
  await pane.settle();
  assert.equal(pane.$('.html-view__notice-text--health').textContent, 'The page is not responding.');
  const reload = [...document.querySelectorAll('.html-view__notice-button')].find((b) => b.textContent === 'Reload');
  assert.equal(reload.hidden, false);
  reload.click();
  await pane.settle();
  assert.equal(pane.preview.calls.reloads, 1);
  assert.equal(pane.$('.html-view__notice').hidden, true);

  pane.preview.emit({ type: 'gone', reason: 'crashed' });
  await pane.settle();
  assert.equal(pane.$('.html-view__notice-text--health').textContent, 'The page has stopped.');
  pane.preview.emit({ type: 'loaded' });
  await pane.settle();
  assert.equal(pane.$('.html-view__notice').hidden, true);
});

test('a page that cannot be shown says why, and Reload tries again', async (t) => {
  let answer = { ok: false, reason: 'too-large', size: 3 * 1024 * 1024 };
  const preview = fakePreview({ open: async () => answer });
  const pane = await mountPane(t, { preview });
  await pane.host.open(item('big.html'));
  await pane.settle();
  assert.equal(pane.$('.html-view__stage').hidden, true);
  assert.equal(pane.$('.html-view__message-title').textContent, 'Too large to preview');
  assert.equal(
    pane.$('.html-view__message-detail').textContent,
    'HTML files up to 1.0\u00a0MB are shown; this file has 3.0\u00a0MB. Open in browser still works.',
  );
  assert.equal(pane.$('#preview-meta').textContent, '3.0 MB');
  // No page, so no bounds.
  assert.deepEqual(preview.calls.bounds, []);

  answer = { ok: true, id: PAGE_ID, size: 10, mtimeMs: 2 };
  pane.$('.html-tools__reload').click();
  await pane.settle();
  assert.equal(pane.$('.html-view__stage').hidden, false);
  assert.ok(preview.lastBounds());
});

test('each reason has its own words', async (t) => {
  const expected = {
    'not-found': 'The file cannot be read',
    'outside-workspace': 'Outside the open folder',
    'no-workspace': 'No folder open',
    unavailable: 'The preview could not start',
  };
  const preview = fakePreview({ open: async (filePath) => ({ ok: false, reason: filePath.slice(4, -5) }) });
  const pane = await mountPane(t, { preview });
  for (const [reason, title] of Object.entries(expected)) {
    await pane.host.open(item(`${reason}.html`));
    await pane.settle();
    assert.equal(pane.$('.html-view__message-title').textContent, title, reason);
  }
});

test('without the channel the view says the preview could not start', async (t) => {
  const pane = await mountPane(t);
  pane.api.htmlPreview = undefined;
  await pane.host.open(item('index.html'));
  await pane.settle();
  // The api object is read at mount; this mount happened with the channel gone.
  assert.equal(pane.$('.html-view__message-title').textContent, 'The preview could not start');
});

test('an empty file says so instead of a white page', async (t) => {
  const preview = fakePreview({ open: async () => ({ ok: true, id: PAGE_ID, size: 0, mtimeMs: 1 }) });
  const pane = await mountPane(t, { preview });
  await pane.host.open(item('empty.html', { size: 0 }));
  await pane.settle();
  assert.equal(pane.$('.html-view__message-title').textContent, 'This file is empty');
  assert.equal(pane.$('.html-view__stage').hidden, true);
  assert.equal(preview.lastBounds(), null);

  preview.setCheckResult({ ok: true, reloaded: true, size: 42, mtimeMs: 2 });
  await pane.host.refresh('/ws/empty.html');
  await pane.settle();
  assert.equal(pane.$('.html-view__stage').hidden, false);
  assert.ok(preview.lastBounds());
});

test('a change on disk asks main to compare; a file that went away closes the page', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  await pane.host.refresh('/ws/index.html');
  await pane.host.revalidate(['/ws/css']);
  assert.equal(pane.preview.calls.checks, 2);

  pane.preview.setCheckResult({ ok: false, reason: 'not-found' });
  await pane.host.refresh('/ws/index.html');
  await pane.settle();
  assert.deepEqual(pane.preview.calls.closed, [PAGE_ID]);
  assert.equal(pane.$('.html-view__message-title').textContent, 'The file cannot be read');
  // Back again: the next look opens it anew.
  await pane.host.refresh('/ws/index.html');
  await pane.settle();
  assert.equal(pane.preview.calls.open.length, 2);
});

test('Source shows the text and hides the page; the shortcut switches back', async (t) => {
  const files = { '/ws/index.html': '<!doctype html>\n<p>Hi</p>' };
  const pane = await mountPane(t, { files });
  await pane.host.open(item('index.html'));
  await pane.settle();
  pane.$('.file-view-mode-switch input[value="source"]').click();
  await pane.settle();
  assert.equal(pane.preview.lastBounds(), null);
  assert.equal(pane.$('#preview-content').textContent, files['/ws/index.html']);
  assert.equal(pane.$('.html-view').hidden, true);

  assert.equal(pane.host.runCommand('toggle-source'), true);
  await pane.settle();
  assert.equal(pane.$('.html-view').hidden, false);
  assert.ok(pane.preview.lastBounds());
});

test('a source that cannot be read says why', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  pane.host.runCommand('toggle-source');
  await pane.settle();
  const message = document.querySelector('.html-view__source .html-view__message');
  assert.equal(message.hidden, false);
  assert.equal(message.querySelector('.html-view__message-title').textContent, 'Source not available');
});

test('a link to another file opens it through the tree; one that fails says so', async (t) => {
  let answer = { ok: true };
  const pane = await mountPane(t, { openFile: () => answer });
  await pane.host.open(item('index.html'));
  await pane.settle();
  pane.preview.emit({ type: 'open-file', path: '/ws/other.html', fragment: 'top' });
  await pane.settle();
  assert.deepEqual(pane.opened, ['/ws/other.html']);

  answer = { ok: false, reason: 'not-found' };
  pane.preview.emit({ type: 'open-file', path: '/ws/missing.html', fragment: '' });
  await pane.settle();
  assert.equal(pane.$('.html-view__flash').textContent, '/ws/missing.html does not exist in the open folder.');
});

test('the fragment of the link that opened the file goes to the page', async (t) => {
  const pane = await mountPane(t, { openFile: async () => ({ ok: true }) });
  await pane.host.open(item('index.html'));
  await pane.settle();
  // As the Markdown view does it: a link into another file, with a fragment.
  const { host } = pane;
  await host.openFromLink('/ws/guide.html', { fragment: 'install' });
  await host.open(item('guide.html'));
  await pane.settle();
  assert.deepEqual(pane.preview.calls.open.at(-1), { filePath: '/ws/guide.html', options: { fragment: 'install' } });
  // The page left behind is closed.
  assert.deepEqual(pane.preview.calls.closed, [PAGE_ID]);
});

test('Tab into the stage hands the keyboard to the page; F6 there comes back after it', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  const stage = pane.$('.html-view__stage');
  assert.equal(stage.tabIndex, 0);
  assert.equal(stage.getAttribute('aria-label'), 'Page index.html. Tab moves into the page, F6 back out of it.');
  stage.focus();
  await pane.settle();
  assert.equal(pane.preview.calls.focus, 1);

  pane.preview.emit({ type: 'focus-leave', reverse: true });
  assert.equal(document.activeElement, pane.$('.html-tools__browser'));
  stage.focus();
  pane.preview.emit({ type: 'focus-leave', reverse: false });
  assert.notEqual(document.activeElement, stage);
});

test('"Open in browser" hands the file over; a failure is said', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('fails.html'));
  await pane.settle();
  pane.$('.html-tools__browser').click();
  await pane.settle();
  assert.deepEqual(pane.preview.calls.browser, ['/ws/fails.html']);
  assert.equal(pane.$('.html-view__flash').textContent, 'The file could not be handed to the browser.');
});

test('leaving the file closes the page and stops listening', async (t) => {
  const pane = await mountPane(t);
  await pane.host.open(item('index.html'));
  await pane.settle();
  await pane.host.open(item('notes.txt'));
  assert.deepEqual(pane.preview.calls.closed, [PAGE_ID]);
  assert.equal(pane.preview.listening, false);
});

test('a page opened after the view was left is closed at once', async (t) => {
  let release;
  const preview = fakePreview({ open: () => new Promise((resolve) => { release = resolve; }) });
  const pane = await mountPane(t, { preview });
  void pane.host.open(item('slow.html'));
  await pane.settle();
  pane.host.clear();
  release({ ok: true, id: PAGE_ID, size: 1, mtimeMs: 1 });
  await pane.settle();
  assert.deepEqual(preview.calls.closed, [PAGE_ID]);
});

test('German, the same content', async (t) => {
  const pane = await mountPane(t);
  pane.i18n.setLocale('de');
  t.after(() => pane.i18n.setLocale('en'));
  await pane.host.open(item('index.html'));
  await pane.settle();
  pane.preview.emit({ type: 'blocked', total: 1, entries: [{ url: 'https://a.example/', reason: 'network' }] });
  await pane.settle();
  assert.equal(pane.$('.html-tools__reload').getAttribute('aria-label'), 'Neu laden');
  assert.equal(pane.$('.html-tools__browser').getAttribute('aria-label'), 'Im Browser öffnen');
  assert.match(pane.$('.html-view__notice-text--blocked').textContent, /^1 Anfrage blockiert\. Die Vorschau bleibt offline/);
  assert.equal(pane.$('.html-view__notice-row--blocked .html-view__notice-button').textContent, 'Anzeigen');
});
