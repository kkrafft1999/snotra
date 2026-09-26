// The content pane as host of the file views, against the real markup (#225):
// switching views, the fallbacks, and the gate an editor with unsaved changes
// can close.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const item = (name, extra = {}) => ({ path: `/ws/${name}`, name, size: 10, modified: 1, ...extra });

/** A view that writes down what the host does with it. */
function recordingView(id, { kind = 'viewer', exts = ['txt'], save } = {}) {
  const log = [];
  const view = {
    id,
    kind,
    canHandle: ({ ext }) => exts.includes(ext),
    mount(hostEl, context) {
      const node = document.createElement('div');
      node.className = `${id}-node`;
      node.textContent = context.content;
      hostEl.append(node);
      const entry = { hostEl, node, context, updates: [], unmounted: false };
      log.push(entry);
      return {
        update(snapshot) {
          entry.updates.push(snapshot);
          node.textContent = snapshot.content;
        },
        unmount() {
          entry.unmounted = true;
        },
        save: save ? () => save(entry) : undefined,
      };
    },
  };
  return { view, log };
}

async function mountHost(t, { files = {}, views, confirmLeave, openFile, getWorkspaceRoot } = {}) {
  const dom = setupRendererDom();
  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const { createFileViewRegistry } = await importRenderer('file-views', 'registry.js');
  const reads = [];
  const api = {
    readFile: async (path) => {
      reads.push(path);
      const entry = files[path];
      if (typeof entry === 'function') return entry();
      return entry ?? { error: `ENOENT: ${path}` };
    },
  };
  const registry = views ? createFileViewRegistry(views) : undefined;
  const host = createFileViewHost({ api, registry, confirmLeave, openFile, getWorkspaceRoot });
  // A host that outlives its test would still answer a language switch, into
  // a window that is gone.
  t.after(() => {
    host.dispose();
    dom.cleanup();
  });
  const el = (id) => document.getElementById(id);
  const shows = () => ({
    welcome: !el('welcome').classList.contains('hidden'),
    preview: !el('file-preview').classList.contains('hidden'),
    info: !el('file-info').classList.contains('hidden'),
  });
  return { host, files, reads, el, shows };
}

const text = (content, extra = {}) => ({ content, size: content.length, modified: 5, ...extra });

test('a text file mounts the plain-text view under the pane header', async (t) => {
  const { host, el, shows } = await mountHost(t, { files: { '/ws/a.txt': text('hello') } });

  assert.equal(await host.open(item('a.txt')), true);
  assert.deepEqual(shows(), { welcome: false, preview: true, info: false });
  assert.equal(el('preview-filename').textContent, 'a.txt');
  assert.equal(el('preview-meta').textContent, '5 B');
  const views = el('preview-body').children;
  assert.equal(views.length, 1);
  assert.equal(views[0].dataset.view, 'plain-text');
  assert.equal(el('preview-content').parentElement, views[0]);
  assert.equal(el('preview-content').textContent, 'hello');
  assert.equal(el('preview-tools').hidden, true);
  assert.equal(host.openPath(), '/ws/a.txt');
});

test('an empty file is an empty view, not the info card', async (t) => {
  const { host, el, shows } = await mountHost(t, { files: { '/ws/empty.txt': text('') } });

  await host.open(item('empty.txt'));
  assert.deepEqual(shows(), { welcome: false, preview: true, info: false });
  assert.equal(el('preview-content').textContent, '');
  assert.equal(el('preview-meta').textContent, '0 B');
});

test('a very long line stays one line in the view', async (t) => {
  const line = 'x'.repeat(20000);
  const { host, el } = await mountHost(t, { files: { '/ws/long.txt': text(line) } });

  await host.open(item('long.txt'));
  assert.equal(el('preview-content').textContent, line);
  assert.equal(el('preview-content').tagName, 'PRE');
});

test('a file no view claims goes to the info card without being read', async (t) => {
  const { host, el, reads, shows } = await mountHost(t);

  assert.equal(await host.open(item('photo.png', { size: 2048 })), true);
  assert.deepEqual(shows(), { welcome: false, preview: false, info: true });
  assert.deepEqual(reads, []);
  assert.equal(el('info-filename').textContent, 'photo.png');
  assert.equal(el('info-size').textContent, '2.0 KB');
  assert.equal(el('info-type').textContent, 'png');
});

test('a file over the preview limit shows the error on the info card', async (t) => {
  const { host, el, shows } = await mountHost(t, {
    files: { '/ws/big.txt': { error: 'File too large for preview', size: 2 * 1024 * 1024 } },
  });

  await host.open(item('big.txt'));
  assert.deepEqual(shows(), { welcome: false, preview: false, info: true });
  assert.equal(el('info-size').textContent, 'File too large for preview');
  assert.equal(el('preview-body').children.length, 0);
});

test('switching files unmounts the old view and mounts the new one in a fresh element', async (t) => {
  const { view, log } = recordingView('rec');
  const { host, el } = await mountHost(t, {
    views: [view],
    files: { '/ws/a.txt': text('A'), '/ws/b.txt': text('B') },
  });

  await host.open(item('a.txt'));
  const first = log[0];
  first.hostEl.scrollTop = 500;
  await host.open(item('b.txt'));

  assert.equal(first.unmounted, true);
  assert.equal(first.hostEl.isConnected, false);
  assert.equal(log[1].hostEl.isConnected, true);
  assert.notEqual(log[1].hostEl, first.hostEl);
  assert.equal(log[1].hostEl.scrollTop, 0);
  assert.equal(el('preview-body').children.length, 1);
  assert.equal(el('preview-filename').textContent, 'b.txt');
});

test('switching to a binary file unmounts the view too', async (t) => {
  const { view, log } = recordingView('rec');
  const { host, el, shows } = await mountHost(t, { views: [view], files: { '/ws/a.txt': text('A') } });

  await host.open(item('a.txt'));
  await host.open(item('photo.png'));
  assert.equal(log[0].unmounted, true);
  assert.equal(el('preview-body').children.length, 0);
  assert.deepEqual(shows(), { welcome: false, preview: false, info: true });
});

test('close unmounts and goes back to the welcome screen', async (t) => {
  const { view, log } = recordingView('rec');
  const { host, shows } = await mountHost(t, { views: [view], files: { '/ws/a.txt': text('A') } });

  await host.open(item('a.txt'));
  assert.equal(await host.close('file-removed'), true);
  assert.equal(log[0].unmounted, true);
  assert.deepEqual(shows(), { welcome: true, preview: false, info: false });
  assert.equal(host.openPath(), null);
});

test('a refresh with new text reaches update(), with the same text it does not', async (t) => {
  const { view, log } = recordingView('rec');
  const { host, files, el } = await mountHost(t, { views: [view], files: { '/ws/a.txt': text('old') } });

  await host.open(item('a.txt'));
  await host.refresh('/ws/a.txt');
  assert.deepEqual(log[0].updates, [], 'unchanged text is not handed back');

  files['/ws/a.txt'] = text('new text', { modified: 9 });
  await host.refresh('/ws/a.txt');
  assert.deepEqual(log[0].updates, [{ content: 'new text', size: 8, modified: 9 }]);
  assert.equal(el('preview-meta').textContent, '8 B');
  assert.equal(log.length, 1, 'the view stays mounted');
});

test('the plain-text view keeps its node across a refresh', async (t) => {
  const { host, files, el } = await mountHost(t, { files: { '/ws/a.txt': text('old') } });

  await host.open(item('a.txt'));
  const pre = el('preview-content');
  files['/ws/a.txt'] = text('new');
  await host.refresh('/ws/a.txt');
  assert.equal(el('preview-content'), pre);
  assert.equal(pre.textContent, 'new');
});

test('a refresh for a file that is not on show reads nothing', async (t) => {
  const { host, reads } = await mountHost(t, { files: { '/ws/a.txt': text('A') } });

  await host.refresh('/ws/a.txt');
  await host.open(item('a.txt'));
  reads.length = 0;
  await host.refresh('/ws/other.txt');
  await host.open(item('photo.png'));
  await host.refresh('/ws/photo.png');
  assert.deepEqual(reads, []);
});

test('a file that grows past the limit shows the error instead of the stale text', async (t) => {
  const { host, files, el, shows } = await mountHost(t, { files: { '/ws/a.txt': text('small') } });

  await host.open(item('a.txt'));
  files['/ws/a.txt'] = { error: 'File too large for preview', size: 5 * 1024 * 1024 };
  await host.refresh('/ws/a.txt');
  assert.deepEqual(shows(), { welcome: false, preview: false, info: true });
  assert.equal(el('info-size').textContent, 'File too large for preview');

  // Shrinks again: the next report brings the view back.
  files['/ws/a.txt'] = text('small again');
  await host.refresh('/ws/a.txt');
  assert.deepEqual(shows(), { welcome: false, preview: true, info: false });
  assert.equal(el('preview-content').textContent, 'small again');
});

test('clicking the open file again keeps the view instead of remounting it', async (t) => {
  const { view, log } = recordingView('rec');
  const { host, files } = await mountHost(t, { views: [view], files: { '/ws/a.txt': text('A') } });

  await host.open(item('a.txt'));
  files['/ws/a.txt'] = text('A2');
  assert.equal(await host.open(item('a.txt')), true);
  assert.equal(log.length, 1);
  assert.equal(log[0].unmounted, false);
  assert.deepEqual(log[0].updates.map((u) => u.content), ['A2']);
});

test('a slow read that a newer click overtook is dropped', async (t) => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const { host, el } = await mountHost(t, {
    files: { '/ws/slow.txt': () => slow, '/ws/fast.txt': text('fast') },
  });

  const first = host.open(item('slow.txt'));
  const second = host.open(item('fast.txt'));
  assert.equal(await second, true);
  release(text('slow'));
  assert.equal(await first, false);
  assert.equal(el('preview-filename').textContent, 'fast.txt');
  assert.equal(el('preview-content').textContent, 'fast');
});

test('a view claims the tool area through setTools, and the switch clears it', async (t) => {
  const tooled = {
    id: 'tooled',
    kind: 'viewer',
    canHandle: ({ ext }) => ext === 'md',
    mount(hostEl, { setTools }) {
      const button = document.createElement('button');
      button.textContent = 'Source';
      setTools([button]);
      return { update() {}, unmount() {} };
    },
  };
  const { view } = recordingView('rec');
  const { host, el } = await mountHost(t, {
    views: [tooled, view],
    files: { '/ws/a.md': text('# A'), '/ws/b.txt': text('B') },
  });

  await host.open(item('a.md'));
  assert.equal(el('preview-tools').hidden, false);
  assert.equal(el('preview-tools').textContent, 'Source');
  await host.open(item('b.txt'));
  assert.equal(el('preview-tools').hidden, true);
  assert.equal(el('preview-tools').childElementCount, 0);
});

test('a view that throws on mount leaves the info card, not a half-built pane', async (t) => {
  const broken = {
    id: 'broken',
    kind: 'viewer',
    canHandle: () => true,
    mount() { throw new Error('no canvas'); },
  };
  const { host, el, shows } = await mountHost(t, { views: [broken], files: { '/ws/a.txt': text('A') } });
  t.mock.method(console, 'error', () => {});

  await host.open(item('a.txt'));
  assert.deepEqual(shows(), { welcome: false, preview: false, info: true });
  assert.equal(el('info-size').textContent, 'no canvas');
});

test('the header size follows the interface language', async (t) => {
  const { host, el } = await mountHost(t, { files: { '/ws/a.txt': text('x'.repeat(1536)) } });
  const { setLocale } = await importRenderer('i18n.js');
  t.after(() => setLocale('en', { force: true }));

  await host.open(item('a.txt'));
  assert.equal(el('preview-meta').textContent, '1.5 KB');
  setLocale('de', { force: true });
  assert.equal(el('preview-meta').textContent, '1,5 KB');
});

// ── Editors: unsaved changes ────────────────────────────────────────────────

async function mountWithDirtyEditor(t, { answer, save } = {}) {
  const asked = [];
  const { view: editor, log } = recordingView('editor', { kind: 'editor', exts: ['md'], save });
  const { view: viewer } = recordingView('viewer', { exts: ['txt'] });
  const setup = await mountHost(t, {
    views: [editor, viewer],
    files: { '/ws/a.md': text('# A'), '/ws/b.txt': text('B') },
    confirmLeave: answer === undefined ? undefined : async (question) => {
      asked.push(question);
      return answer;
    },
  });
  await setup.host.open(item('a.md'));
  log[0].context.setDirty(true);
  return { ...setup, asked, log };
}

test('an editor with unsaved changes is asked before another file replaces it', async (t) => {
  const { host, asked, log, el } = await mountWithDirtyEditor(t, { answer: 'cancel' });

  assert.equal(host.hasUnsavedChanges(), true);
  assert.equal(await host.open(item('b.txt')), false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].reason, 'switch-file');
  assert.equal(asked[0].file.path, '/ws/a.md');
  assert.equal(log[0].unmounted, false);
  assert.equal(el('preview-filename').textContent, 'a.md');
});

test('without a dialog, unsaved changes keep the editor where it is', async (t) => {
  const { host, log } = await mountWithDirtyEditor(t);

  assert.equal(await host.open(item('b.txt')), false);
  assert.equal(await host.close('file-removed'), false);
  assert.equal(log[0].unmounted, false);
});

test('discard lets the switch through', async (t) => {
  const { host, log, el } = await mountWithDirtyEditor(t, { answer: 'discard' });

  assert.equal(await host.open(item('b.txt')), true);
  assert.equal(log[0].unmounted, true);
  assert.equal(el('preview-filename').textContent, 'b.txt');
  assert.equal(host.hasUnsavedChanges(), false);
});

test('save runs the editor save first, and a failed save keeps the editor', async (t) => {
  let result = false;
  const saves = [];
  const { host, log } = await mountWithDirtyEditor(t, {
    answer: 'save',
    save: async (entry) => { saves.push(entry); return result; },
  });

  assert.equal(await host.open(item('b.txt')), false, 'save failed');
  assert.equal(log[0].unmounted, false);
  result = true;
  assert.equal(await host.open(item('b.txt')), true);
  assert.equal(saves.length, 2);
  assert.equal(log[0].unmounted, true);
});

test('a deleted file asks with its own reason', async (t) => {
  const { host, asked } = await mountWithDirtyEditor(t, { answer: 'cancel' });

  assert.equal(await host.close('file-removed'), false);
  assert.equal(asked[0].reason, 'file-removed');
});

test('settleUnsaved closes a discarded buffer at once, so it cannot linger', async (t) => {
  const { host, log, shows } = await mountWithDirtyEditor(t, { answer: 'discard' });

  assert.equal(await host.settleUnsaved('switch-folder'), true);
  assert.equal(log[0].unmounted, true);
  assert.deepEqual(shows(), { welcome: true, preview: false, info: false });
});

test('settleUnsaved with a clean pane neither asks nor closes', async (t) => {
  const asked = [];
  const { host, shows } = await mountHost(t, {
    files: { '/ws/a.txt': text('A') },
    confirmLeave: async (q) => { asked.push(q); return 'discard'; },
  });

  await host.open(item('a.txt'));
  assert.equal(await host.settleUnsaved('switch-folder'), true);
  assert.deepEqual(asked, []);
  assert.deepEqual(shows(), { welcome: false, preview: true, info: false });
});

test('two questions at once become one dialog', async (t) => {
  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  const asked = [];
  const { view: editor, log } = recordingView('editor', { kind: 'editor', exts: ['md'] });
  const { host } = await mountHost(t, {
    views: [editor],
    files: { '/ws/a.md': text('# A') },
    confirmLeave: (q) => { asked.push(q); return pending; },
  });
  await host.open(item('a.md'));
  log[0].context.setDirty(true);

  const first = host.close('file-removed');
  const second = host.settleUnsaved('switch-folder');
  await flush();
  answer('cancel');
  assert.deepEqual([await first, await second], [false, false]);
  assert.equal(asked.length, 1);
});

test('a viewer cannot hold the pane: setDirty is ignored for it', async (t) => {
  const asked = [];
  const { view, log } = recordingView('rec');
  const { host } = await mountHost(t, {
    views: [view],
    files: { '/ws/a.txt': text('A'), '/ws/b.txt': text('B') },
    confirmLeave: async (q) => { asked.push(q); return 'cancel'; },
  });

  await host.open(item('a.txt'));
  log[0].context.setDirty(true);
  assert.equal(host.hasUnsavedChanges(), false);
  assert.equal(await host.open(item('b.txt')), true);
  assert.deepEqual(asked, []);
});

test('an editor with unsaved changes survives a file it can no longer read', async (t) => {
  const { host, files, log, shows } = await mountWithDirtyEditor(t, { answer: 'cancel' });

  files['/ws/a.md'] = { error: 'File too large for preview' };
  await host.refresh('/ws/a.md');
  assert.deepEqual(shows(), { welcome: false, preview: true, info: false });
  assert.equal(log[0].unmounted, false);
});

test('an external change reaches a dirty editor through update(), not by remounting', async (t) => {
  const { host, files, log } = await mountWithDirtyEditor(t, { answer: 'cancel' });

  files['/ws/a.md'] = text('# A, from the agent');
  await host.refresh('/ws/a.md');
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].updates.map((u) => u.content), ['# A, from the agent']);
  assert.equal(host.hasUnsavedChanges(), true, 'what to do with the buffer is the editor’s call');
});

test('a view asks for another file through the host; a view that is gone cannot (#344)', async (t) => {
  const { view, log } = recordingView('rec', { exts: ['txt'] });
  const asked = [];
  const { host } = await mountHost(t, {
    views: [view],
    files: { '/ws/a.txt': text('a'), '/ws/b.txt': text('b') },
    openFile: async (p) => { asked.push(p); return { ok: true }; },
    getWorkspaceRoot: () => '/ws',
  });

  await host.open(item('a.txt'));
  const first = log[0].context;
  assert.equal(first.workspaceRoot, '/ws');
  assert.deepEqual(await first.openFile('/ws/b.txt'), { ok: true });
  assert.deepEqual(asked, ['/ws/b.txt']);

  await host.open(item('b.txt'));
  assert.deepEqual(await first.openFile('/ws/c.txt'), { ok: false, reason: 'stale' });
  assert.deepEqual(asked, ['/ws/b.txt'], 'the replaced view no longer reaches the tree');
});

test('without an opener a view is told the file is not there', async (t) => {
  const { view, log } = recordingView('rec', { exts: ['txt'] });
  const { host } = await mountHost(t, { views: [view], files: { '/ws/a.txt': text('a') } });
  await host.open(item('a.txt'));
  assert.equal(log[0].context.workspaceRoot, null);
  assert.deepEqual(await log[0].context.openFile('/ws/b.txt'), { ok: false, reason: 'not-found' });
});
