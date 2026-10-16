const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom } = require('./helpers/dom.js');

// #863: editing a text file in the preview — the Edit toggle, autosave, the
// save state, conflicts and the lock while the agent works — through the real
// host and the real views, with main's channels as stand-ins.

const sha256 = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const item = (name) => ({ path: `/ws/${name}`, name, size: 10, modified: 1 });
const text = (content) => ({ content, size: Buffer.byteLength(content), modified: 5 });

/**
 * Until a save under way has come back — the hash runs on the thread pool, so
 * by the clock rather than by ticks — and then a few turns more.
 */
async function settle() {
  const until = Date.now() + 5000;
  while (document.querySelector('.file-edit-status')?.dataset.state === 'saving' && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function mountPane(t, { files = {}, writeResults = [] } = {}) {
  const dom = setupRendererDom();
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };
  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const disk = { ...files };
  const writes = [];
  const reads = [];
  const api = {
    setUIPrefs: async () => ({}),
    readFile: async (p) => {
      reads.push(p);
      return disk[p] === undefined ? { error: `ENOENT: ${p}`, reason: 'missing' } : text(disk[p]);
    },
    writeFile: async (p, content, options) => {
      writes.push({ path: p, content, ...options });
      const result = writeResults.length ? writeResults.shift() : { ok: true };
      if (result.ok) disk[p] = content;
      return result.ok ? { ok: true, size: Buffer.byteLength(content), modified: 9 } : result;
    },
  };
  const host = createFileViewHost({ api, getWorkspaceRoot: () => '/ws' });
  t.after(() => {
    host.dispose();
    dom.cleanup();
  });
  const $ = (selector) => document.querySelector(selector);
  const editor = () => $('.text-editor');
  return {
    host,
    disk,
    writes,
    reads,
    $,
    editor,
    toggle: () => $('.file-edit-toggle'),
    status: () => $('.file-edit-status'),
    notice: () => $('.file-edit-notice'),
    noticeButtons: () => [...document.querySelectorAll('.file-edit-notice__action')],
    type(value) {
      editor().value = value;
      editor().dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    key(key, { mod = false } = {}) {
      const event = new window.KeyboardEvent('keydown', { key, metaKey: mod, ctrlKey: mod, bubbles: true, cancelable: true });
      editor().dispatchEvent(event);
      return event;
    },
  };
}

test('the Edit toggle swaps the text for an editor holding the same text', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/a.txt': 'hello\n' } });
  await pane.host.open(item('a.txt'));

  const toggle = pane.toggle();
  assert.ok(toggle, 'the toggle sits in the header');
  assert.equal(toggle.closest('#preview-tools') !== null, true);
  assert.equal(toggle.textContent, 'Edit');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(pane.editor(), null, 'read-only by default');

  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(pane.editor().value, 'hello\n');
  assert.equal(pane.$('#preview-content').hidden, true);
  assert.equal(document.activeElement, pane.editor());
  assert.equal(pane.editor().getAttribute('aria-label'), 'Text of a.txt');
});

test('Mod+S saves with the hash of the text on disk, Escape goes back to reading', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/a.txt': 'hello\n' } });
  await pane.host.open(item('a.txt'));
  pane.toggle().click();

  pane.type('hello world\n');
  assert.equal(pane.host.hasUnsavedChanges(), true);
  assert.equal(pane.status().textContent, 'Saving…');
  assert.equal(pane.key('s', { mod: true }).defaultPrevented, true);
  await settle();

  assert.deepEqual(pane.writes, [{ path: '/ws/a.txt', content: 'hello world\n', baseHash: sha256('hello\n'), force: false }]);
  assert.equal(pane.status().textContent, 'Saved');
  assert.equal(pane.host.hasUnsavedChanges(), false);
  assert.equal(pane.$('#preview-meta').textContent, '12 B', 'the header follows the saved size');

  pane.key('Escape');
  await settle();
  assert.equal(pane.editor(), null);
  assert.equal(pane.$('#preview-content').hidden, false);
  assert.equal(pane.$('#preview-content').textContent, 'hello world\n');
  assert.equal(document.activeElement, pane.toggle());
  assert.equal(pane.status().hidden, true);
  assert.equal(pane.writes.length, 1, 'leaving with nothing new writes nothing');
});

test('the save of the editor does not come back as a change on disk', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/a.txt': 'one' } });
  await pane.host.open(item('a.txt'));
  pane.toggle().click();
  pane.type('two');
  pane.key('s', { mod: true });
  await settle();

  // The watcher reports the write.
  await pane.host.refresh('/ws/a.txt');
  assert.equal(pane.notice().hidden, true);
  assert.equal(pane.editor().value, 'two');
});

test('Tab is left to the focus order, the editor does not claim it', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/a.txt': 'x' } });
  await pane.host.open(item('a.txt'));
  pane.toggle().click();

  assert.equal(pane.key('Tab').defaultPrevented, false);
});

test('a file with CRLF line endings is saved with CRLF, and an untouched one not at all', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/win.txt': 'a\r\nb\r\n', '/ws/mixed.txt': 'a\r\nb\nc' } });
  await pane.host.open(item('mixed.txt'));
  pane.toggle().click();
  pane.editor().dispatchEvent(new window.Event('blur'));
  pane.toggle().click();
  await settle();
  assert.equal(pane.writes.length, 0, 'opening and leaving the editor changes nothing');

  await pane.host.open(item('win.txt'));
  pane.toggle().click();
  assert.equal(pane.editor().value, 'a\nb\n');
  pane.type('a\nb\nc\n');
  pane.key('s', { mod: true });
  await settle();
  assert.equal(pane.writes[0].content, 'a\r\nb\r\nc\r\n');
});

test('a conflict from main asks: keep my version writes over the disk', async (t) => {
  const pane = await mountPane(t, {
    files: { '/ws/a.txt': 'disk' },
    writeResults: [{ conflict: 'changed' }],
  });
  await pane.host.open(item('a.txt'));
  pane.toggle().click();
  pane.type('mine');
  pane.key('s', { mod: true });
  await settle();

  assert.equal(pane.notice().hidden, false);
  assert.equal(pane.notice().getAttribute('role'), 'alert');
  assert.match(pane.notice().textContent, /Another program changed this file/);
  assert.equal(pane.status().textContent, 'Not saved');
  const [keep, take] = pane.noticeButtons();
  assert.equal(keep.textContent, 'Keep my version');
  assert.equal(take.textContent, 'Use the version on disk');
  assert.equal(pane.host.hasUnsavedChanges(), true);

  keep.click();
  await settle();
  assert.equal(pane.writes[1].force, true);
  assert.equal(pane.writes[1].content, 'mine');
  assert.equal(pane.notice().hidden, true);
  assert.equal(pane.status().textContent, 'Saved');
});

test('a conflict from main asks: the version on disk replaces the editor’s text', async (t) => {
  const pane = await mountPane(t, {
    files: { '/ws/a.txt': 'disk' },
    writeResults: [{ conflict: 'changed' }],
  });
  await pane.host.open(item('a.txt'));
  pane.toggle().click();
  pane.disk['/ws/a.txt'] = 'theirs';
  pane.type('mine');
  pane.key('s', { mod: true });
  await settle();

  pane.noticeButtons()[1].click();
  await settle();
  assert.equal(pane.editor().value, 'theirs');
  assert.equal(pane.notice().hidden, true);
  assert.equal(pane.host.hasUnsavedChanges(), false);
  assert.equal(pane.writes.length, 1);
});

test('a change on disk while editing: taken when nothing is lost, a conflict when it is', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/a.txt': 'one\ntwo\n' } });
  await pane.host.open(item('a.txt'));
  pane.toggle().click();

  pane.disk['/ws/a.txt'] = 'one\ntwo\nthree\n';
  await pane.host.refresh('/ws/a.txt');
  assert.equal(pane.editor().value, 'one\ntwo\nthree\n', 'nothing typed: the disk version is taken');
  assert.equal(pane.notice().hidden, true);

  pane.type('one\ntwo\nthree\nfour\n');
  pane.disk['/ws/a.txt'] = 'zero\n';
  await pane.host.refresh('/ws/a.txt');
  assert.equal(pane.editor().value, 'one\ntwo\nthree\nfour\n', 'the user’s text is never replaced');
  assert.equal(pane.notice().hidden, false);
  assert.equal(pane.writes.length, 0);
});

test('another file saves the editor first, without a question', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/a.txt': 'a', '/ws/b.txt': 'b' } });
  await pane.host.open(item('a.txt'));
  pane.toggle().click();
  pane.type('a, edited');

  assert.equal(await pane.host.open(item('b.txt')), true);
  assert.equal(pane.writes.length, 1);
  assert.equal(pane.disk['/ws/a.txt'], 'a, edited');
  assert.equal(pane.$('#preview-filename').textContent, 'b.txt');
});

test('a failed save keeps the editor and offers to retry or discard', async (t) => {
  const pane = await mountPane(t, {
    files: { '/ws/a.txt': 'a', '/ws/b.txt': 'b' },
    writeResults: [{ error: 'EACCES', reason: 'permission' }, { error: 'EACCES', reason: 'permission' }],
  });
  await pane.host.open(item('a.txt'));
  pane.toggle().click();
  pane.type('a, edited');

  assert.equal(await pane.host.open(item('b.txt')), false, 'the pane stays');
  assert.equal(pane.$('#preview-filename').textContent, 'a.txt');
  assert.equal(pane.editor().value, 'a, edited');
  assert.match(pane.notice().textContent, /could not be saved: you have no permission to write this file\./);
  const [retry, discard] = pane.noticeButtons();
  assert.equal(retry.textContent, 'Try again');
  assert.equal(discard.textContent, 'Discard my changes');

  retry.click();
  await settle();
  assert.equal(pane.writes.length, 2);
  assert.equal(pane.notice().hidden, false, 'still failing');

  discard.click();
  await settle();
  assert.equal(pane.editor(), null);
  assert.equal(pane.$('#preview-content').textContent, 'a');
  assert.equal(pane.host.hasUnsavedChanges(), false);
  assert.equal(await pane.host.open(item('b.txt')), true);
});

test('a file deleted under unsaved text stays until the text is given up', async (t) => {
  const pane = await mountPane(t, {
    files: { '/ws/a.txt': 'a' },
    writeResults: [{ conflict: 'deleted' }],
  });
  await pane.host.open(item('a.txt'));
  pane.toggle().click();
  pane.type('a, edited');
  delete pane.disk['/ws/a.txt'];

  assert.equal(await pane.host.close('file-removed'), false);
  assert.match(pane.notice().textContent, /was deleted while you were editing/);
  const [keep, discard] = pane.noticeButtons();
  assert.equal(keep.textContent, 'Keep my version');
  assert.equal(discard.textContent, 'Discard my changes');

  discard.click();
  await settle();
  assert.equal(pane.$('#welcome').classList.contains('hidden'), false, 'the pane closed after all');
});

test('no editing while the agent works: the toggle explains, a running editor saves and stops', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/a.txt': 'a' } });
  pane.host.setEditingBlocked(true);
  await pane.host.open(item('a.txt'));

  assert.equal(pane.toggle().getAttribute('aria-disabled'), 'true');
  assert.equal(pane.toggle().title, 'Editing is paused while the agent is working.');
  pane.toggle().click();
  assert.equal(pane.editor(), null);

  pane.host.setEditingBlocked(false);
  assert.equal(pane.toggle().hasAttribute('aria-disabled'), false);
  pane.toggle().click();
  pane.type('a, edited');
  pane.host.setEditingBlocked(true);
  await settle();
  assert.equal(pane.writes.length, 1, 'what was typed is saved before the agent starts');
  assert.equal(pane.editor(), null);
  assert.equal(pane.$('#preview-content').textContent, 'a, edited');
});

test('a file that is not UTF-8 cannot be edited', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/latin1.txt': 'Gr��e' } });
  await pane.host.open(item('latin1.txt'));

  assert.equal(pane.toggle().getAttribute('aria-disabled'), 'true');
  assert.match(pane.toggle().title, /not UTF-8/);
  pane.toggle().click();
  assert.equal(pane.editor(), null);
});

test('Markdown: the toggle sits next to "Preview | Source", and the preview shows what was saved', async (t) => {
  const pane = await mountPane(t, { files: { '/ws/n.md': '# Old\n' } });
  await pane.host.open(item('n.md'));
  assert.equal(pane.toggle(), null, 'no toggle in the preview');

  pane.host.runCommand('toggle-source');
  const tools = [...pane.$('#preview-tools').children];
  assert.equal(tools[0].classList.contains('file-view-mode-switch'), true);
  assert.equal(tools[1], pane.toggle());

  pane.toggle().click();
  pane.type('# New\n');
  pane.host.runCommand('toggle-source');
  await settle();
  assert.equal(pane.writes[0].content, '# New\n', 'leaving the source saves');
  assert.equal(pane.$('.md-doc h1').textContent, 'New');
  assert.equal(pane.toggle(), null);
});

test('Markdown: a save that fails keeps the source on show', async (t) => {
  const pane = await mountPane(t, {
    files: { '/ws/n.md': '# Old\n' },
    writeResults: [{ error: 'EACCES', reason: 'permission' }],
  });
  await pane.host.open(item('n.md'));
  pane.host.runCommand('toggle-source');
  pane.toggle().click();
  pane.type('# New\n');
  pane.host.runCommand('toggle-source');
  await settle();

  assert.equal(pane.$('.md-source').hidden, false);
  assert.equal(pane.$('#preview-tools .ds-segmented__input[value="source"]').checked, true);
  assert.equal(pane.notice().hidden, false);
});
